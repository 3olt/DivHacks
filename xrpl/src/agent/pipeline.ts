// The agent's end-to-end path for one submitted invoice:
//   invoice (json/txt/pdf/png, UNTRUSTED) -> Grok verifier -> proposal (no address) -> payment builder (deterministic
//   cross-checks vs Mongo + registry) -> payInvoice (agent signs) -> co-signer (independent 8 checks) -> XRPL Testnet.
// Every attempt, including every refusal, is recorded as a Decision + Payment.
import type { Payment as XrplPayment } from "xrpl";
import type { Decision } from "../../../shared/contracts";
import { findContract, findNonprofit } from "../lib/mongo";
import { rlusd, sourceTag } from "../lib/xrpl";
import { notEvaluatedChecks } from "../cosigner/checks";
import { verifyInvoice, type ContractTerms, type InvoiceInput, type Proposal } from "../verifier";
import type { VerifierMeta } from "../verifier";
import { buildFromProposal, type SubmissionMeta } from "./builder";
import { baseDecision, buildMemo, clip, decisionCore, isoSeconds, newDecisionId, paymentFor } from "./decision";
import { agentAudit } from "./audit";
import { payInvoice, type AgentCtx, type Attempt } from "./payInvoice";

export interface Submission extends SubmissionMeta {
  input: InvoiceInput;
}

export interface PipelineResult extends Attempt {
  stage: "verifier" | "payment_builder" | "cosigner" | "ledger";
  proposal: Proposal | null;
  verifier: VerifierMeta | null;
}

export function grokReasoning(p: Proposal, meta: VerifierMeta): string {
  return `[Grok ${meta.model}, ${meta.latency_ms} ms, input ${String(meta.input.format ?? "?")}] ${p.reasoning} Proof: ${p.proof_summary}`;
}

/** Runs one invoice through verifier -> builder -> payInvoice. */
export async function processSubmission(sub: Submission, ctx: AgentCtx): Promise<PipelineResult> {
  if (!ctx.db) throw new Error("the Phase 2 pipeline needs MongoDB (contracts + registry); MONGODB_URI is not reachable");
  const { log } = ctx;
  const contract = await findContract(ctx.db, sub.contract_id);
  const np = contract ? await findNonprofit(ctx.db, contract.nonprofit_ein) : null;
  const terms: ContractTerms = {
    contract_id: sub.contract_id,
    agency_code: contract?.agency_code ?? "unknown",
    payee_ein: contract?.nonprofit_ein ?? "unknown",
    payee_name: np?.name ?? "unknown",
    purpose: contract?.purpose ?? null,
    start_date: contract?.start_date ?? "unknown",
    end_date: contract?.end_date ?? "unknown",
    xrpl_budget_rlusd: contract?.xrpl_budget_rlusd ?? "0",
    currency: "RLUSD",
    is_demo_data: contract?.is_demo_data ?? true,
  };

  // 1. Grok verifier (fail closed).
  log(`verifier: sending ${sub.input.name} (${sub.input.kind}) to Grok as untrusted data, with the terms of contract ${sub.contract_id}`);
  const v = await verifyInvoice(sub.input, terms);
  const now = new Date();
  if (!v.ok) {
    log(`verifier: UNAVAILABLE (${v.message}); failing closed, nothing built or signed`);
    const decision_id = newDecisionId(now);
    const core = decisionCore(
      { invoice_id: sub.expected_invoice_id ?? `unknown-${decision_id}`, contract_id: sub.contract_id, payee_ein: terms.payee_ein, amount: "0" },
      decision_id, isoSeconds(now), `Grok verifier unavailable (${v.message}); failing closed: no proposal, so no payment was built or signed.`, sourceTag(),
    );
    const decision: Decision = { ...baseDecision(core), refusal_reasons: ["verifier_unavailable"], checks: notEvaluatedChecks("the verifier failed before any payment was built") };
    const payment = paymentFor(decision);
    const recorded = await ctx.recorder.record(decision, payment, { stage: "verifier", verifier: v.meta, verifier_error: v.message, input: sub.input.name });
    return { decision, payment, destination: null, explorer_url: null, delivered_amount: null, engine_result: null, memo_json: null, recorded, stage: "verifier", proposal: null, verifier: v.meta };
  }
  const p = v.proposal;
  log(
    `verifier: proposal in ${v.meta.latency_ms} ms: invoice ${p.invoice_id}, contract ${p.contract_id}, EIN ${p.payee_ein}, ${p.amount} ${p.currency}, ` +
      `period ${p.period.from}..${p.period.to}, suspicious_instructions_found=${p.suspicious_instructions_found}` +
      (v.meta.addresses_removed ? `, ${v.meta.addresses_removed} address(es) scrubbed from the output` : ""),
  );
  for (const e of p.suspicious_excerpts) log(`verifier:   suspicious excerpt: ${JSON.stringify(e)}`);

  // 2. Payment builder: deterministic cross-checks; destination from the registry by EIN only.
  const b = buildFromProposal(p, sub, contract, ctx.reg, `unknown-${newDecisionId(now)}`, now);
  if (!b.ok) {
    log(`builder: REFUSED (${b.reasons.join(", ")}): ${b.problems.join("; ")}. Nothing signed.`);
    const decision_id = newDecisionId(now);
    const reasoning = `${grokReasoning(p, v.meta)} Payment builder REFUSED before signing: ${b.problems.join("; ")}.`;
    const core = decisionCore(b.ids, decision_id, isoSeconds(now), reasoning, sourceTag());
    const base = baseDecision(core);
    // Audit record: the would-be payment to the REGISTRY wallet (never signed, never sent to the co-signer).
    let checks = notEvaluatedChecks("the payment builder refused before a transaction could be built");
    let memo_json: string | null = null;
    if (b.would_be_destination && b.ids.amount !== "0") {
      const memo = buildMemo(core, base.decision_hash);
      memo_json = memo.json;
      const R = rlusd();
      const wouldBe: XrplPayment = {
        TransactionType: "Payment", Account: ctx.reg.agent_account, Destination: b.would_be_destination,
        Amount: { currency: R.currency, issuer: R.issuer, value: b.ids.amount }, SourceTag: sourceTag(), Memos: [memo.memo],
      };
      // Multisig form (empty SigningPubKey), exactly what the agent would have signed; it is never signed here.
      // Record-keeping only: if the ledger cannot be read for the audit, the refusal is still recorded.
      try {
        const prepared = { ...(await ctx.client.autofill(wouldBe, 2)), SigningPubKey: "" };
        checks = (await agentAudit(prepared as unknown as Record<string, unknown>, b.ids.invoice_id, ctx, "would-be payment to the registry wallet; never signed, co-signer not asked")).checks;
      } catch (e) {
        checks = notEvaluatedChecks(`the payment builder refused before signing; the audit of the would-be payment could not read the ledger (${(e as Error).message.slice(0, 160)})`);
      }
    }
    const decision: Decision = { ...base, refusal_reasons: b.reasons, checks, enforced_by: null, signers: [] };
    const payment = paymentFor(decision);
    const recorded = await ctx.recorder.record(decision, payment, {
      stage: "payment_builder", enforced_by_note: "agent policy (payment builder); nothing was signed", problems: b.problems,
      proposal: p, verifier: v.meta, input: sub.input.name, would_be_destination: b.would_be_destination, memo_json,
    });
    return { decision, payment, destination: null, explorer_url: null, delivered_amount: null, engine_result: null, memo_json, recorded, stage: "payment_builder", proposal: p, verifier: v.meta };
  }

  // 3. Sign + co-signer + ledger.
  log(`builder: OK: ${b.notes.join("; ")}`);
  const reasoning = clip(`${grokReasoning(p, v.meta)} Payment builder: ${b.notes.join("; ")}.`);
  const r = await payInvoice(b.invoice, ctx, { reasoning, audit: { proposal: p, verifier: v.meta, input: sub.input.name } });
  const stage = r.engine_result ? "ledger" : "cosigner";
  return { ...r, stage, proposal: p, verifier: v.meta };
}
