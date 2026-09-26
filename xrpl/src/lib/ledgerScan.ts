// On-ledger history of agent_account: the source of truth for "already paid", "paid under this contract" and the
// rolling 24h caps. Reads `account_tx` (validated ledgers only, all pages) with the caller's own XRPL connection.
// Holds no keys and never trusts anything but the ledger's own records.
//
// Only tesSUCCESS Payments SENT BY agent_account count, and amounts are the ledger's `delivered_amount` in RLUSD
// (currency + issuer must match). Failed `tec` transactions also consume a Sequence and carry our memo, so they are
// ignored for sums; they are still listed in `hashes` so a pending co-signature can be recognised as settled.
import { rippleTimeToUnixTime, type Client } from "xrpl";
import { MEMO_TYPE, type PaymentMemo } from "../../../shared/hash";
import { fromHex } from "./xrpl";
import { invoiceKey } from "./invoiceId";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** RLUSD amounts are compared as integers of 1e-6 RLUSD, so sums never drift with floating point. */
export const toMicro = (v: string | number): number => Math.round(Number(v) * 1e6);
export const fromMicro = (m: number): string => (m / 1e6).toFixed(6).replace(/\.?0+$/, "") || "0";
/** Human display with 2 decimals, e.g. 87.5 -> "87.50". */
export const fmt = (m: number): string => (m / 1e6).toFixed(2);

export interface LedgerPayment {
  hash: string;
  ledger_index: number;
  close_time_ms: number;
  close_time_iso: string;
  destination: string;
  delivered_micro: number;
  /** Decoded divhacks/payment/v1 memo, or null if the tx has none (e.g. Phase 0 test payments). */
  memo: PaymentMemo | null;
}

export interface AgentHistory {
  agent_account: string;
  /** Transactions examined (all pages; incoming and outgoing). */
  scanned: number;
  pages: number;
  /** Highest validated ledger covered by the scan. */
  ledger_index_max: number;
  /** tesSUCCESS RLUSD Payments sent by agent_account, newest first. */
  payments: LedgerPayment[];
  /** Hashes of every validated tx sent by agent_account (any result). */
  sent_hashes: Set<string>;
}

type Memo = { Memo?: { MemoType?: string; MemoData?: string } };
type AccountTxItem = {
  hash?: string;
  ledger_index?: number;
  close_time_iso?: string;
  validated?: boolean;
  meta?: { TransactionResult?: string; delivered_amount?: unknown } | string;
  tx_json?: { TransactionType?: string; Account?: string; Destination?: string; Memos?: Memo[]; date?: number; hash?: string };
};

export function decodePaymentMemo(memos: Memo[] | undefined): PaymentMemo | null {
  if (!Array.isArray(memos)) return null;
  for (const m of memos) {
    try {
      if (!m.Memo?.MemoType || fromHex(m.Memo.MemoType) !== MEMO_TYPE || !m.Memo.MemoData) continue;
      const d = JSON.parse(fromHex(m.Memo.MemoData)) as Record<string, unknown>;
      if (["inv", "ctr", "ein", "dh", "rv"].every((k) => typeof d[k] === "string")) return d as unknown as PaymentMemo;
    } catch {
      /* not our memo */
    }
  }
  return null;
}

/** Scans agent_account's full validated history (newest first, all pages). Throws if the ledger cannot be read. */
export async function scanAgentHistory(client: Client, agentAccount: string, rlusd: { currency: string; issuer: string }, maxPages = 50): Promise<AgentHistory> {
  const out: AgentHistory = { agent_account: agentAccount, scanned: 0, pages: 0, ledger_index_max: 0, payments: [], sent_hashes: new Set() };
  let marker: unknown = undefined;
  do {
    const req: Record<string, unknown> = { command: "account_tx", account: agentAccount, ledger_index_min: -1, ledger_index_max: -1, limit: 200, api_version: 2 };
    if (marker !== undefined) req.marker = marker;
    const res = (await client.request(req as never)) as { result: { transactions: AccountTxItem[]; marker?: unknown; ledger_index_max?: number } };
    out.pages++;
    out.ledger_index_max = Math.max(out.ledger_index_max, Number(res.result.ledger_index_max ?? 0));
    for (const item of res.result.transactions) {
      out.scanned++;
      const tx = item.tx_json;
      const meta = typeof item.meta === "object" ? item.meta : undefined;
      if (!tx || tx.Account !== agentAccount || item.validated === false) continue;
      const hash = String(item.hash ?? tx.hash ?? "").toUpperCase();
      if (hash) out.sent_hashes.add(hash);
      if (tx.TransactionType !== "Payment" || meta?.TransactionResult !== "tesSUCCESS") continue;
      const da = meta.delivered_amount as { currency?: string; issuer?: string; value?: string } | string | undefined;
      if (typeof da !== "object" || !da || da.currency !== rlusd.currency || da.issuer !== rlusd.issuer || typeof da.value !== "string") continue;
      const closeMs = item.close_time_iso ? Date.parse(item.close_time_iso) : typeof tx.date === "number" ? rippleTimeToUnixTime(tx.date) : NaN;
      out.payments.push({
        hash,
        ledger_index: Number(item.ledger_index ?? 0),
        close_time_ms: closeMs,
        close_time_iso: Number.isFinite(closeMs) ? new Date(closeMs).toISOString() : "unknown",
        destination: String(tx.Destination ?? ""),
        delivered_micro: toMicro(da.value),
        memo: decodePaymentMemo(tx.Memos),
      });
    }
    marker = res.result.marker;
  } while (marker !== undefined && out.pages < maxPages);
  if (marker !== undefined) throw new Error(`agent_account history has more than ${maxPages} pages; refusing to decide on a partial scan`);
  return out;
}

/**
 * The tesSUCCESS payment that already settled this invoice, if any. Matching is spelling-insensitive (invoiceKey:
 * case, punctuation and separators are ignored) and scoped to the payee EIN when one is given (a memo without an ein
 * matches any payee). An id with no canonical form never matches here; the caller refuses it separately.
 */
export function paidInvoice(h: AgentHistory, invoiceId: string, payeeEin?: string | null): LedgerPayment | undefined {
  const key = invoiceKey(invoiceId);
  if (!key) return undefined;
  return h.payments.find((p) => !!p.memo && invoiceKey(p.memo.inv) === key && (!payeeEin || !p.memo.ein || p.memo.ein === payeeEin));
}

export function contractPaidMicro(h: AgentHistory, contractId: string): { micro: number; count: number } {
  const ps = h.payments.filter((p) => p.memo?.ctr === contractId);
  return { micro: ps.reduce((s, p) => s + p.delivered_micro, 0), count: ps.length };
}

/** Rolling 24h (by ledger close time) totals sent by agent_account: overall and to one destination. */
export function rolling24h(h: AgentHistory, nowMs: number, destination?: string): { micro: number; count: number } {
  const ps = h.payments.filter((p) => Number.isFinite(p.close_time_ms) && p.close_time_ms > nowMs - DAY_MS && (!destination || p.destination === destination));
  return { micro: ps.reduce((s, p) => s + p.delivered_micro, 0), count: ps.length };
}
