import { createHash } from "node:crypto";
import type { Decision } from "../../../shared/contracts";

/**
 * Canonical JSON: object keys sorted (recursively), no whitespace, `undefined` object members dropped,
 * array order preserved. This is what `decision_hash` is computed over.
 */
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

/** decision_hash = SHA-256 (lowercase hex) of the canonical JSON of the decision without `decision_hash`. */
export function computeDecisionHash(decision: Omit<Decision, "decision_hash"> | Decision): string {
  const { decision_hash: _ignored, ...rest } = decision as Decision;
  return sha256Hex(canonicalJson(rest));
}

/** The MemoData JSON the payment builder puts on-ledger (Phase 1 spec): {inv, ctr, ein, dh, rv}. */
export function memoJson(d: Pick<Decision, "invoice_id" | "contract_id" | "payee_ein" | "decision_hash" | "rule_version">): string {
  return JSON.stringify({ inv: d.invoice_id, ctr: d.contract_id, ein: d.payee_ein, dh: d.decision_hash, rv: d.rule_version });
}

/**
 * Obviously fake 64-hex transaction hash for fixtures: "00000000FA15E" + zero padding + n in hex.
 * These do NOT exist on any ledger.
 */
export function fakeTxHash(n: number): string {
  const tail = n.toString(16).toUpperCase();
  return `00000000FA15E${tail.padStart(64 - 13, "0")}`;
}
