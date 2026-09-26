"use client";

// Connects the open-data page to XRPL Testnet: agent_account's history (account_tx), every registry account's
// live state, and a live subscription so new transactions appear without a reload. Read-only.
//
// Connection lifecycle: one socket at a time. If it drops (or a 30 s ping goes unanswered) it reconnects on its own
// with backoff (2, 4, 8, 16, 30 s...), re-reads account_tx and merges it into the rows already shown (so nothing
// that arrived live is lost and nothing missed while disconnected is skipped), then re-subscribes. After
// MAX_AUTO_RETRIES failures in a row it stops and waits for the Reconnect button. Unmount closes the socket and
// clears every timer.
import { useEffect, useState } from "react";
import {
  LedgerClient,
  XRPL_TESTNET_WS,
  fetchAccountStates,
  fetchAccountTx,
  mergeTxRows,
  parseLedgerTx,
  roleIndex,
  subscribeAccounts,
  type AccountState,
  type LedgerTxRow,
  type Registry,
} from "@/lib/ledger";

export type Phase = "idle" | "loading" | "ready" | "error";

export interface LedgerView {
  txPhase: Phase;
  txError: string | null;
  txs: LedgerTxRow[];
  truncated: boolean;
  accPhase: Phase;
  accError: string | null;
  accounts: AccountState[];
  /**
   * off = no socket yet; connecting = opening one; live = subscribed and connected;
   * reconnecting = dropped, retrying at `retryAt`; closed = gave up retrying (use Reconnect).
   */
  live: "off" | "connecting" | "live" | "reconnecting" | "closed";
  liveError: string | null;
  /** When the next automatic reconnect runs (ISO), while `live` is "reconnecting". */
  retryAt: string | null;
  /** Successful reconnects after the first connection. */
  reconnects: number;
  lastEventAt: string | null;
  url: string;
}

export const LEDGER_INITIAL: LedgerView = {
  txPhase: "idle",
  txError: null,
  txs: [],
  truncated: false,
  accPhase: "idle",
  accError: null,
  accounts: [],
  live: "off",
  liveError: null,
  retryAt: null,
  reconnects: 0,
  lastEventAt: null,
  url: XRPL_TESTNET_WS,
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const LEDGER_LOADING: LedgerView = { ...LEDGER_INITIAL, txPhase: "loading", accPhase: "loading", live: "connecting" };

export const MAX_AUTO_RETRIES = 8;
const PING_EVERY_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const backoffMs = (failures: number) => Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));

/** `attempt` re-runs everything from scratch (Reconnect button). */
export function useLedger(registry: Registry | null, attempt: number): LedgerView {
  // State is tagged with the run it belongs to, so a new run starts from "loading" without a reset inside the effect.
  const runKey = registry ? `${registry.agent_account}#${attempt}` : "";
  const [state, setState] = useState<{ key: string; view: LedgerView }>({ key: "", view: LEDGER_INITIAL });

  useEffect(() => {
    if (!registry) return;
    let cancelled = false;
    let client: LedgerClient | null = null;
    let everConnected = false;
    let failures = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    const key = `${registry.agent_account}#${attempt}`;
    const update = (patch: Partial<LedgerView> | ((v: LedgerView) => Partial<LedgerView>)) => {
      if (cancelled) return;
      setState((s) => {
        const base = s.key === key ? s.view : LEDGER_LOADING;
        return { key, view: { ...base, ...(typeof patch === "function" ? patch(base) : patch) } };
      });
    };
    const roles = roleIndex(registry);
    const stopTimers = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (pingTimer) clearInterval(pingTimer);
      refreshTimer = null;
      pingTimer = null;
    };

    const refreshAccounts = (c: LedgerClient) =>
      fetchAccountStates(c, registry).then(
        (accounts) => {
          // A dropped socket turns every row into "error"; keep the last good balances instead.
          if (c.isOpen || accounts.some((a) => a.status !== "error")) update({ accPhase: "ready", accError: null, accounts });
        },
        (e: unknown) => update((v) => (v.accPhase === "ready" ? { accError: message(e) } : { accPhase: "error", accError: message(e) })),
      );

    const scheduleRetry = (reason: string) => {
      if (cancelled) return;
      stopTimers();
      failures++;
      if (failures > MAX_AUTO_RETRIES) {
        update((v) => ({
          live: "closed",
          liveError: `${reason} (gave up after ${MAX_AUTO_RETRIES} automatic retries)`,
          retryAt: null,
          ...(v.txPhase !== "ready" ? { txPhase: "error" as const, txError: reason } : {}),
          ...(v.accPhase !== "ready" ? { accPhase: "error" as const, accError: reason } : {}),
        }));
        return;
      }
      const delay = backoffMs(failures);
      update((v) => ({
        live: "reconnecting",
        liveError: reason,
        retryAt: new Date(Date.now() + delay).toISOString(),
        // Nothing loaded yet: show the failure in the panels (they keep retrying underneath).
        ...(v.txPhase !== "ready" ? { txPhase: "error" as const, txError: reason } : {}),
        ...(v.accPhase !== "ready" ? { accPhase: "error" as const, accError: reason } : {}),
      }));
      retryTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (cancelled) return;
      retryTimer = null;
      update({ live: "connecting", retryAt: null });
      LedgerClient.connect(XRPL_TESTNET_WS).then(
        (c) => {
          if (cancelled) {
            c.close();
            return;
          }
          client = c;
          const isReconnect = everConnected;
          everConnected = true;
          c.onClose((reason) => {
            if (client === c) client = null;
            scheduleRetry(`Connection to XRPL Testnet lost: ${reason}`);
          });
          c.onStream((msg) => {
            if (msg.type !== "transaction") return;
            const row = parseLedgerTx(msg, roles, { focus: registry.agent_account, live: true });
            if (!row) return;
            update((v) => ({ txs: mergeTxRows([row], v.txs), lastEventAt: new Date().toISOString() }));
            // Balances changed: re-read them shortly after (coalesce bursts).
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => void refreshAccounts(c), 1500);
          });
          // Heartbeat: a half-open socket never fires "close", so an unanswered ping forces a reconnect.
          pingTimer = setInterval(() => {
            c.request({ command: "ping" }, PING_TIMEOUT_MS).catch(() => c.close("no answer to ping"));
          }, PING_EVERY_MS);

          // Subscribe first so nothing validated between the history read and the subscription is missed
          // (duplicates are merged by hash).
          subscribeAccounts(c, [registry.agent_account]).then(
            () => {
              failures = 0;
              update((v) => ({ live: c.isOpen ? "live" : v.live, liveError: null, retryAt: null, reconnects: v.reconnects + (isReconnect ? 1 : 0) }));
            },
            (e: unknown) => {
              if (c.isOpen) c.close(`subscribe failed: ${message(e)}`);
            },
          );
          fetchAccountTx(c, registry, { max: 400 }).then(
            (r) => update((v) => ({ txPhase: "ready", txError: null, txs: mergeTxRows(v.txs, r.rows), truncated: r.truncated })),
            (e: unknown) => {
              // A dropped socket is handled by the reconnect path; anything else is a real query error.
              if (c.isOpen) update((v) => (v.txPhase === "ready" ? { txError: message(e) } : { txPhase: "error", txError: message(e) }));
            },
          );
          void refreshAccounts(c);
        },
        (e: unknown) => scheduleRetry(`Could not reach XRPL Testnet (${message(e)})`),
      );
    };

    connect();

    return () => {
      cancelled = true;
      stopTimers();
      if (retryTimer) clearTimeout(retryTimer);
      client?.close();
      client = null;
    };
  }, [registry, attempt]);

  if (!registry) return LEDGER_INITIAL;
  return state.key === runKey ? state.view : LEDGER_LOADING;
}
