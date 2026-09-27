// Turns one agent Decision into the payment pipeline it went through, and where it stopped:
// invoice -> AI invoice check (Grok) -> agent policy -> co-signer (8 checks) -> XRP Ledger.
// Derived only from the Decision's own fields (docs/API.md); nothing is recomputed.
import type { Decision } from "./contracts";
import { refusalLabel } from "./format";

// fail = this layer stopped the payment; sim = a step the demo deliberately staged (a hacked agent).
export type StepStatus = "pass" | "fail" | "wait" | "skip" | "sim";
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
  const flagged = reasons.includes("suspicious_instructions_in_invoice");
  let grok: Step = flagged
    ? { name: "AI invoice check (Grok)", status: "fail", detail: "Flagged hidden instructions in the invoice" }
    : { name: "AI invoice check (Grok)", status: "pass", detail: "Facts extracted; matches the contract" };
  let policy: Step = { name: "Agent policy", status: "pass", detail: "Wallet taken only from the registry by EIN; agent signs (weight 1)" };
  let cosigner: Step = { name: "Co-signer: 8 checks", status: "pass", detail: `${passed}/${d.checks.length} checks passed; co-signs (weight 2, reaching the 3 needed)` };
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

  // Red-team runs where the agent is deliberately compromised (it obeys the malicious invoice): show that at the
  // agent steps, so the later layers are what stop it.
  if (d.agent_reasoning.startsWith("[SIMULATED COMPROMISED AGENT")) {
    grok = { name: "AI invoice check (Grok)", status: "skip", detail: "Grok flagged it, but this simulated hacked agent ignores the flag" };
    policy = { name: "Agent policy", status: "sim", detail: "Simulated hack: the agent obeys the invoice and targets the scammer's wallet" };
  }

  // Refused: find the layer that stopped it.
  // Grok flagged it but later layers still ran: a simulated compromised agent ignored the flag.
  if (flagged && d.enforced_by && grok.status !== "skip") grok = { ...grok, detail: "Flagged hidden instructions (a compromised agent ignored the flag)" };

  if (d.enforced_by === "ledger") {
    if (!cosignerSigned) cosigner = { name: "Co-signer: 8 checks", status: "skip", detail: "Skipped: the agent sent the payment alone" };
    ledger = { name: "XRP Ledger", status: "fail", detail: `${d.ledger_result ?? "Rejected"}: ${first}` };
    return [invoice, grok, policy, cosigner, ledger];
  }
  if (d.enforced_by === "cosigner") {
    cosigner = { name: "Co-signer: 8 checks", status: "fail", detail: `${first}${failedChecks.length ? ` (failed: ${failedChecks.join(", ")})` : ""}` };
    stopAt("cosigner");
    return [invoice, grok, policy, cosigner, ledger];
  }
  if (d.enforced_by === "hold") {
    // The 72-hour wallet-change hold is enforced by the co-signer (it keeps its own record of every hold).
    cosigner = { name: "Co-signer: 8 checks", status: "fail", detail: `${first} (enforced by the co-signer)` };
    stopAt("cosigner");
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
