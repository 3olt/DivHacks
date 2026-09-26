// XRPL helpers shared by setup, the agent and the co-signer (Testnet only).
// This module never loads env files and never touches a seed: callers pass Wallets in explicitly.
// (Adapted from scripts/risk/_lib.ts, which loads the setup-only .env.local on import and so must not be
// imported by a signer process.)
import { Client, type Wallet, type SubmittableTransaction, type TxResponse } from "xrpl";

export const LSF_DISABLE_MASTER = 0x00100000;

export function xrplWs(): string {
  const ws = process.env.XRPL_WS ?? "wss://s.altnet.rippletest.net:51233";
  if (!/altnet|testnet|devnet/.test(ws)) throw new Error(`refusing to run against non-test network ${ws}`);
  return ws;
}

export function rlusd(): { currency: string; issuer: string } {
  const issuer = process.env.RLUSD_ISSUER ?? "";
  const currency = process.env.RLUSD_CURRENCY_HEX ?? "";
  if (!issuer || !/^[0-9A-F]{40}$/.test(currency)) throw new Error("RLUSD_ISSUER / RLUSD_CURRENCY_HEX missing from the root .env");
  return { currency, issuer };
}

export function sourceTag(): number {
  return Number(process.env.AGENT_SOURCE_TAG ?? "26092026");
}

export const explorerTx = (hash: string) => `https://testnet.xrpl.org/transactions/${hash}`;
export const explorerAccount = (address: string) => `https://testnet.xrpl.org/accounts/${address}`;
export const toHex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
export const fromHex = (h: string) => Buffer.from(h, "hex").toString("utf8");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function connect(): Promise<Client> {
  const client = new Client(xrplWs(), { timeout: 30000 });
  await client.connect();
  return client;
}

function rpcError(e: unknown): string {
  return String((e as { data?: { error?: string } }).data?.error ?? (e as Error).message ?? e);
}

/** XRP balance (validated ledger), or null if the account does not exist. */
export async function xrpBalance(client: Client, address: string): Promise<number | null> {
  try {
    const r = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
    return Number(r.result.account_data.Balance) / 1e6;
  } catch (e) {
    if (rpcError(e).includes("actNotFound")) return null;
    throw e;
  }
}

/** Token balance on the holder's trust line to issuer (0 if no line). */
export async function tokenBalance(client: Client, holder: string, issuer: string, currency: string): Promise<number> {
  try {
    const lines = await client.request({ command: "account_lines", account: holder, peer: issuer, ledger_index: "validated" });
    const line = lines.result.lines.find((l) => l.currency === currency);
    return line ? Number(line.balance) : 0;
  } catch (e) {
    if (rpcError(e).includes("actNotFound")) return 0;
    throw e;
  }
}

export async function hasTrustLine(client: Client, holder: string, issuer: string, currency: string): Promise<boolean> {
  const lines = await client.request({ command: "account_lines", account: holder, peer: issuer, ledger_index: "validated" });
  return lines.result.lines.some((l) => l.currency === currency);
}

export interface SignerListInfo {
  quorum: number;
  entries: { account: string; weight: number }[];
}

export interface AccountState {
  exists: boolean;
  flags: number;
  masterDisabled: boolean;
  signerList: SignerListInfo | null;
}

/** account_info with signer_lists (handles API v1 and v2 response shapes). */
export async function accountState(client: Client, address: string): Promise<AccountState> {
  try {
    const info = await client.request({ command: "account_info", account: address, ledger_index: "validated", signer_lists: true } as never);
    type SL = { SignerQuorum: number; SignerEntries: { SignerEntry: { Account: string; SignerWeight: number } }[] };
    const r = (info as { result: { account_data: { Flags: number; signer_lists?: SL[] }; signer_lists?: SL[] } }).result;
    const sl = (r.signer_lists ?? r.account_data.signer_lists ?? [])[0];
    const flags = Number(r.account_data.Flags);
    return {
      exists: true,
      flags,
      masterDisabled: (flags & LSF_DISABLE_MASTER) !== 0,
      signerList: sl ? { quorum: sl.SignerQuorum, entries: sl.SignerEntries.map((e) => ({ account: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight })) } : null,
    };
  } catch (e) {
    if (rpcError(e).includes("actNotFound")) return { exists: false, flags: 0, masterDisabled: false, signerList: null };
    throw e;
  }
}

/** Calls the Testnet faucet with exponential backoff. Returns the XRP the faucet added. */
export async function fundWithRetry(client: Client, wallet: Wallet, tries = 6): Promise<number> {
  let delay = 5000;
  for (let i = 1; ; i++) {
    try {
      const before = (await xrpBalance(client, wallet.address)) ?? 0;
      const res = await client.fundWallet(wallet, { usageContext: "divhacks-setup" });
      const added = res.balance - before;
      console.log(`    faucet: ${wallet.address} +${added} XRP (balance ${res.balance})`);
      return added;
    } catch (e) {
      console.warn(`    faucet attempt ${i}/${tries} failed: ${(e as Error).message}`);
      if (i >= tries) throw e;
      await sleep(delay);
      delay *= 2;
    }
  }
}

export type Outcome = { hash: string; result: string; link: string; tx: TxResponse["result"] };

/** autofill + sign (single-signer) + submitAndWait; returns the validated TransactionResult. */
export async function submitWait(client: Client, tx: SubmittableTransaction, wallet: Wallet, label: string): Promise<Outcome> {
  const res = await client.submitAndWait(tx, { autofill: true, wallet });
  const result = (res.result.meta as { TransactionResult: string }).TransactionResult;
  const out = { hash: res.result.hash, result, link: explorerTx(res.result.hash), tx: res.result };
  console.log(`    ${label}: ${result} ${out.link}`);
  return out;
}

export interface SubmitResult {
  /** Preliminary result from the `submit` call (e.g. tesSUCCESS, tefBAD_QUORUM, temMALFORMED), or "submit_error". */
  engine_result: string;
  engine_result_message: string;
  /**
   * validated: in a validated ledger (final = its TransactionResult, tesSUCCESS or tec*)
   * rejected:  tef/tem/tel preliminary result; it never reaches a ledger (final = engine_result)
   * expired:   the validated ledger passed LastLedgerSequence and the tx is not in it; it can never land
   * unknown:   the final status could not be established before the hard deadline (e.g. connection lost)
   */
  status: "validated" | "rejected" | "expired" | "unknown";
  /** Final result code: the validated TransactionResult, the tef/tem/tel engine_result, "expired_past_LastLedgerSequence" or "unknown". */
  final: string;
  validated: boolean;
  ledger_index?: number;
  meta?: unknown;
  close_time_iso?: string;
}

/** Submits an already-signed blob and waits for a FINAL status: validated, or definitively not landing.
 *  It keeps polling until the tx is validated or the validated ledger passes `lastLedgerSequence`
 *  (a tx inside its LastLedgerSequence window can still land, so a fixed timeout is not final).
 *  If the submit call itself errors, the blob may still have been relayed, so it polls by hash all the same.
 *  `hardDeadlineMs` only guards against a stalled ledger or a dead connection; it yields status "unknown". */
export async function submitBlobAndWait(client: Client, blob: string, hash: string, lastLedgerSequence: number, hardDeadlineMs = 300000): Promise<SubmitResult> {
  let engine_result: string;
  let engine_result_message: string;
  try {
    const r = await client.request({ command: "submit", tx_blob: blob });
    engine_result = r.result.engine_result;
    engine_result_message = r.result.engine_result_message;
  } catch (e) {
    engine_result = "submit_error";
    engine_result_message = rpcError(e);
  }
  const out: SubmitResult = { engine_result, engine_result_message, status: "unknown", final: "unknown", validated: false };
  if (/^(tef|tem|tel)/.test(engine_result)) {
    out.status = "rejected";
    out.final = engine_result;
    return out;
  }
  const end = Date.now() + hardDeadlineMs;
  let pastLls = 0; // consecutive polls that saw validated ledger > LastLedgerSequence without the tx
  while (Date.now() < end) {
    await sleep(1500);
    try {
      const t = await client.request({ command: "tx", transaction: hash });
      const tr = t.result as { validated?: boolean; meta?: { TransactionResult: string }; ledger_index?: number; close_time_iso?: string };
      if (tr.validated && tr.meta) {
        out.status = "validated";
        out.final = tr.meta.TransactionResult;
        out.validated = true;
        out.ledger_index = tr.ledger_index;
        out.meta = tr.meta;
        out.close_time_iso = tr.close_time_iso;
        return out;
      }
    } catch {
      /* txnNotFound until it lands, or a transient connection error: keep polling */
    }
    try {
      const validated = await client.getLedgerIndex();
      pastLls = validated > lastLedgerSequence ? pastLls + 1 : 0;
      // Seen twice (one more tx lookup after the validated ledger passed LLS): it can never land.
      if (pastLls >= 2) {
        out.status = "expired";
        out.final = "expired_past_LastLedgerSequence";
        return out;
      }
    } catch {
      /* connection trouble: keep trying until the hard deadline */
    }
  }
  return out;
}

/** Formats a token amount for the ledger: up to 6 decimals, no trailing zeros. */
export function tokenValue(n: number): string {
  return n.toFixed(6).replace(/\.?0+$/, "");
}

/** Like tokenValue, but rounds DOWN to 6 decimals, so the result never exceeds `n` (for "send at most what we hold"). */
export function tokenValueFloor(n: number): string {
  return tokenValue(Math.floor(n * 1e6 + 1e-9) / 1e6);
}
