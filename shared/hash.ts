// Hashing shared by api/ and xrpl/: the decision hash (dh) that the on-ledger memo commits to.
import { createHash } from "node:crypto";
import type { Decision } from "./contracts";

/** Canonical JSON: object keys sorted recursively, no whitespace, `undefined` members dropped, array order kept. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The decision fields fixed BEFORE anything is signed. `decision_hash` commits to exactly these.
 * Fields filled in afterwards (checks, outcome, refusal_reasons, enforced_by, signers, xrpl_tx_hash,
 * ledger_result) are not covered: they come from the co-signer and the ledger, and the ledger is their proof.
 * (Hashing them would be circular: the tx carries dh in its memo, so dh cannot depend on the tx.)
 */
export const DECISION_HASH_FIELDS = [
  "decision_id",
  "invoice_id",
  "contract_id",
  "payee_ein",
  "amount",
  "currency",
  "agent_reasoning",
  "rule_version",
  "source_tag",
  "created_at",
] as const;

export type DecisionCore = Pick<Decision, (typeof DECISION_HASH_FIELDS)[number]>;

/** decision_hash = SHA-256 (lowercase hex) of the canonical JSON of the decision's pre-signing fields. */
export function computeDecisionHash(decision: DecisionCore): string {
  const core: Record<string, unknown> = {};
  for (const k of DECISION_HASH_FIELDS) core[k] = decision[k];
  return sha256Hex(canonicalJson(core));
}

/** On-ledger MemoData (JSON, then hex-encoded in the tx): {inv, ctr, ein, dh, rv}. */
export interface PaymentMemo {
  inv: string;
  ctr: string;
  ein: string;
  dh: string;
  rv: string;
}

export const MEMO_TYPE = "divhacks/payment/v1";
export const MEMO_FORMAT = "application/json";

/** The exact MemoData JSON string (key order inv, ctr, ein, dh, rv). */
export function memoJson(d: Pick<Decision, "invoice_id" | "contract_id" | "payee_ein" | "decision_hash" | "rule_version">): string {
  const memo: PaymentMemo = { inv: d.invoice_id, ctr: d.contract_id, ein: d.payee_ein, dh: d.decision_hash, rv: d.rule_version };
  return JSON.stringify(memo);
}

/** memo_hash = SHA-256 (lowercase hex) of the MemoData JSON string as written on-ledger. */
export function memoHash(memoJsonText: string): string {
  return sha256Hex(memoJsonText);
}
