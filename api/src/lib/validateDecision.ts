import type { Decision } from "../../../shared/contracts";
import { isRecord } from "./http";

const OUTCOMES = ["released", "held_escrow", "pending_approval", "refused"];
const ENFORCERS = ["cosigner", "ledger", "hold", null];
const CURRENCIES = ["RLUSD", "XRP", "CTT"];

/** Minimal structural validation for a Decision pushed to POST /events/payment. Returns an error message or null.
 *  refusal_reasons are free strings on purpose: every Phase 2/3 code (and any future one) is accepted and shown raw. */
export function decisionShapeError(v: unknown): string | null {
  if (!isRecord(v)) return "decision must be an object";
  const str = (k: string) => typeof v[k] === "string" && (v[k] as string).length > 0;
  const strOrNull = (k: string) => v[k] === null || typeof v[k] === "string";
  const strArr = (k: string) => Array.isArray(v[k]) && (v[k] as unknown[]).every((x) => typeof x === "string");
  for (const k of ["decision_id", "invoice_id", "contract_id", "payee_ein", "amount", "agent_reasoning", "decision_hash", "rule_version", "created_at"]) {
    if (!str(k)) return `decision.${k} must be a non-empty string`;
  }
  if (!/^\d+(\.\d+)?$/.test(v.amount as string)) return "decision.amount must be a decimal string like \"12.50\"";
  if (Number.isNaN(Date.parse(v.created_at as string))) return "decision.created_at must be an ISO 8601 timestamp";
  // CTT (City Test Token) = the SIMULATED milestone escrow's currency (Phase 3); accepted since Phase 5.
  if (!CURRENCIES.includes(v.currency as string)) return `decision.currency must be one of ${CURRENCIES.join(", ")}`;
  if (!OUTCOMES.includes(v.outcome as string)) return `decision.outcome must be one of ${OUTCOMES.join(", ")}`;
  if (!ENFORCERS.includes(v.enforced_by as string | null)) return 'decision.enforced_by must be "cosigner", "ledger", "hold" or null';
  if (!strArr("refusal_reasons")) return "decision.refusal_reasons must be an array of strings";
  if (!strArr("signers")) return "decision.signers must be an array of strings";
  if (!strOrNull("xrpl_tx_hash")) return "decision.xrpl_tx_hash must be a string or null";
  if (!strOrNull("ledger_result")) return "decision.ledger_result must be a string or null";
  if (typeof v.source_tag !== "number" || !Number.isInteger(v.source_tag)) return "decision.source_tag must be an integer";
  if (!Array.isArray(v.checks) || !v.checks.every((c) => isRecord(c) && typeof c.name === "string" && typeof c.passed === "boolean" && typeof c.detail === "string")) {
    return "decision.checks must be an array of {name, passed, detail}";
  }
  return null;
}

export function asDecision(v: unknown): Decision {
  return v as Decision;
}
