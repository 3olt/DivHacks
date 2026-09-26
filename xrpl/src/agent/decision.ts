// Decision + memo construction for the payment agent. Since Phase 2 the agent's reasoning comes from the Grok
// verifier's proposal plus the payment builder's deterministic cross-checks. agent_reasoning is OFF-CHAIN only; the
// on-ledger memo carries only {inv, ctr, ein, dh, rv}, where dh commits to the decision's pre-signing fields.
import { randomBytes } from "node:crypto";
import type { Decision, Invoice, Payment } from "../../../shared/contracts";
import { computeDecisionHash, memoJson, MEMO_TYPE, MEMO_FORMAT, type DecisionCore } from "../../../shared/hash";
import { toHex } from "../lib/xrpl";

export const AGENT_RULE_VERSION = "p2-grok-1";
export const MAX_MEMO_BYTES = 1024;
export const MAX_REASONING_CHARS = 1500;

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

export function clip(s: string, n = MAX_REASONING_CHARS): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function decisionCore(inv: Pick<Invoice, "invoice_id" | "contract_id" | "payee_ein" | "amount">, decision_id: string, created_at: string, reasoning: string, source_tag: number): DecisionCore {
  return {
    decision_id,
    invoice_id: inv.invoice_id,
    contract_id: inv.contract_id,
    payee_ein: inv.payee_ein,
    amount: inv.amount,
    currency: "RLUSD",
    agent_reasoning: clip(reasoning),
    rule_version: AGENT_RULE_VERSION,
    source_tag,
    created_at,
  };
}

/** A Decision with everything after signing still empty (outcome "refused" until the ledger says otherwise). */
export function baseDecision(core: DecisionCore): Decision {
  return {
    ...core,
    outcome: "refused",
    refusal_reasons: [],
    checks: [],
    enforced_by: null,
    decision_hash: computeDecisionHash(core),
    xrpl_tx_hash: null,
    ledger_result: null,
    signers: [],
  };
}

/** The Payment row for an attempt (source "xrpl"; every attempt gets one, refused ones included). */
export function paymentFor(d: Decision, extra: Partial<Payment> = {}): Payment {
  return {
    payment_id: `pay_${d.decision_id.replace(/^dec_/, "")}`,
    source: "xrpl",
    contract_id: d.contract_id,
    payee_ein: d.payee_ein,
    amount: d.amount,
    currency: "RLUSD",
    date: d.created_at,
    status: d.outcome,
    invoice_id: d.invoice_id,
    is_demo_data: true,
    ...extra,
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
