// Turns one agent Decision into the payment pipeline it went through, and where it stopped:
// invoice -> AI invoice check (Grok) -> agent policy -> co-signer (8 checks) -> XRP Ledger.
// Derived only from the Decision's own fields (docs/API.md); nothing is recomputed.
import type { Decision } from "./contracts";
import { refusalLabel } from "./format";

export type StepStatus = "pass" | "fail" | "wait" | "skip";
export interface Step {
  name: string;
  status: StepStatus;
  detail: string;
}

const GROK_CODES = ["suspicious_instructions_in_invoice", "verifier_rejected", "verifier_unavailable"];

export function decisionPipeline(d: Decision): Step[] {
  const reasons = d.refusal_reasons;
  const first = reasons[0] ? refusalLabel(reasons[0]) : "";
  const passed = d.checks.filter((c) => c.passed).length;
  const failedChecks = d.checks.filter((c) => !c.passed).map((c) => c.name);
  const cosignerSigned = d.signers.includes("cosigner");

  const invoice: Step = { name: "Invoice", status: "pass", detail: `${d.invoice_id} · ${d.amount} ${d.currency}` };
  let grok: Step = { name: "AI invoice check (Grok)", status: "pass", detail: "Facts extracted; no hidden instructions; matches the contract" };
  let policy: Step = { name: "Agent policy", status: "pass", detail: "Wallet taken only from the registry by EIN; agent signs (1 of 3 weights)" };
  let cosigner: Step = { name: "Co-signer: 8 checks", status: "pass", detail: `${passed}/${d.checks.length} checks passed; co-signs (2 of 3 weights)` };
  let ledger: Step = { name: "XRP Ledger", status: "pass", detail: d.ledger_result ? `${d.ledger_result}: paid` : "Paid" };

  const stopAt = (step: "grok" | "policy" | "cosigner" | "ledger") => {
    const skipped = (s: Step): Step => ({ ...s, status: "skip", detail: "Not reached" });
    if (step === "grok") [policy, cosigner, ledger] = [skipped(policy), skipped(cosigner), skipped(ledger)];
    if (step === "policy") [cosigner, ledger] = [skipped(cosigner), skipped(ledger)];
    if (step === "cosigner") ledger = skipped(ledger);
  };

  if (d.outcome === "released") return [invoice, grok, policy, cosigner, ledger];

  if (d.outcome === "held_escrow") {
    ledger = { name: "XRP Ledger", status: "wait", detail: "Escrow locked until delivery is confirmed (simulated)" };
    return [invoice, grok, policy, cosigner, ledger];
  }

  if (d.outcome === "pending_approval") {
    cosigner = { name: "Co-signer: 8 checks", status: "wait", detail: `${first}. Waiting for the human officer's signature` };
    stopAt("cosigner");
    return [invoice, grok, policy, cosigner, ledger];
  }

  // Refused: find the layer that stopped it.
  if (d.enforced_by === "ledger") {
    if (!cosignerSigned) cosigner = { name: "Co-signer: 8 checks", status: "skip", detail: "Bypassed: the agent submitted alone" };
    ledger = { name: "XRP Ledger", status: "fail", detail: `${d.ledger_result ?? "Rejected"}: ${first}` };
    return [invoice, grok, policy, cosigner, ledger];
  }
  if (d.enforced_by === "cosigner") {
    cosigner = { name: "Co-signer: 8 checks", status: "fail", detail: `${first}${failedChecks.length ? ` (failed: ${failedChecks.join(", ")})` : ""}` };
    stopAt("cosigner");
    return [invoice, grok, policy, cosigner, ledger];
  }
  if (d.enforced_by === "hold") {
    policy = { name: "Agent policy", status: "fail", detail: first };
    stopAt("policy");
    return [invoice, grok, policy, cosigner, ledger];
  }
  // enforced_by null: stopped by the agent's own pipeline before anything was signed.
  if (reasons.some((r) => GROK_CODES.includes(r))) {
    grok = { name: "AI invoice check (Grok)", status: "fail", detail: first };
    stopAt("grok");
  } else {
    policy = { name: "Agent policy", status: "fail", detail: first || "Refused before signing" };
    stopAt("policy");
  }
  return [invoice, grok, policy, cosigner, ledger];
}
