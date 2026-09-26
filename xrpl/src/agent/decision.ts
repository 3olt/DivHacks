// Decision + memo construction for the payment agent. Phase 1 has no LLM: agent_reasoning is short,
// deterministic text built from the invoice and the registry entry.
import { randomBytes } from "node:crypto";
import type { Invoice } from "../../../shared/contracts";
import { computeDecisionHash, memoJson, MEMO_TYPE, MEMO_FORMAT, type DecisionCore } from "../../../shared/hash";
import { toHex } from "../lib/xrpl";
import type { NonprofitKey, RegistryNonprofit } from "../lib/registry";

export const AGENT_RULE_VERSION = "p1-allowlist-1";
export const MAX_MEMO_BYTES = 1024;

/** UTC yyyymmddHHMMss */
export function utcStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** ISO 8601 UTC with 1-second resolution, e.g. 2026-09-26T18:40:55Z */
export function isoSeconds(d = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function newDecisionId(d = new Date()): string {
  return `dec_${utcStamp(d)}${randomBytes(2).toString("hex")}`;
}

export function agentReasoning(inv: Invoice, np: { key: NonprofitKey; entry: RegistryNonprofit } | null): string {
  if (!np) {
    return `Phase 1 rule-based agent (no LLM). Invoice ${inv.invoice_id} names payee EIN ${inv.payee_ein}, which has no registry wallet; refusing before anything is signed.`;
  }
  return (
    `Phase 1 rule-based agent (no LLM). Invoice ${inv.invoice_id} bills ${inv.amount} ${inv.currency} under contract ${inv.contract_id} ` +
    `for EIN ${inv.payee_ein} (${np.entry.name}). The destination is the registry wallet for that EIN (${np.key}), never an address from the invoice. ` +
    `The agent signs with weight 1; the compliance co-signer (weight 2) must co-sign to reach quorum 3.`
  );
}

export function decisionCore(inv: Invoice, decision_id: string, created_at: string, reasoning: string, source_tag: number): DecisionCore {
  return {
    decision_id,
    invoice_id: inv.invoice_id,
    contract_id: inv.contract_id,
    payee_ein: inv.payee_ein,
    amount: inv.amount,
    currency: "RLUSD",
    agent_reasoning: reasoning,
    rule_version: AGENT_RULE_VERSION,
    source_tag,
    created_at,
  };
}

export interface BuiltMemo {
  memo: { Memo: { MemoType: string; MemoFormat: string; MemoData: string } };
  json: string;
  bytes: number;
}

/** The on-ledger memo: MemoType/MemoFormat/MemoData hex of MEMO_TYPE / MEMO_FORMAT / memoJson({inv,ctr,ein,dh,rv}). */
export function buildMemo(core: DecisionCore, decision_hash: string): BuiltMemo {
  const json = memoJson({ ...core, decision_hash });
  const bytes = Buffer.byteLength(MEMO_TYPE, "utf8") + Buffer.byteLength(MEMO_FORMAT, "utf8") + Buffer.byteLength(json, "utf8");
  if (bytes >= MAX_MEMO_BYTES) throw new Error(`memo is ${bytes} bytes; must be under ${MAX_MEMO_BYTES}`);
  return { memo: { Memo: { MemoType: toHex(MEMO_TYPE), MemoFormat: toHex(MEMO_FORMAT), MemoData: toHex(json) } }, json, bytes };
}

export { computeDecisionHash };
