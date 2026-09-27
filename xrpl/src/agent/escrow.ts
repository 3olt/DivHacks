// SIMULATED milestone escrow, AGENT side (Phase 3, builder B): "simulated escrow (test token, not RLUSD)".
// RLUSD escrow is impossible on Testnet (tecNO_PERMISSION: the RLUSD issuer lacks lsfAllowTrustLineLocking), so the
// escrowed asset is CTT, a City Test Token issued by our own city_issuer. The mechanics are real XLS-85 TokenEscrow txs.
//
//   ensureAgentCttLine()   agent_account's CTT trust line: a multisigned TrustSet (agent + co-signer) through the co-signer's
//                          governance endpoint, which accepts ONLY exactly CTT/city_issuer.
//   createMilestoneEscrow() co-signer issues a PREIMAGE-SHA-256 condition for the milestone (keeps the preimage) ->
//                          EscrowCreate (agent + co-signer; destination = credentialed registry wallet, CTT <= AUTO_LIMIT,
//                          CancelAfter 1..72 h) -> Decision outcome "held_escrow".
//   releaseMilestoneEscrow() the milestone report goes through the Grok verifier + payment builder (untrusted data, same
//                          cross-checks as an invoice, amount must equal the escrow) -> unsigned EscrowFinish template -> the
//                          co-signer re-checks the escrow on-ledger, the credential, registry and holds, AND requires the
//                          OFFICER's signed release approval for this escrow (POST :4004/escrow/milestones/:id/approve-release,
//                          a human click) and a CANONICAL signer list; then it adds the Fulfillment and co-signs -> the agent
//                          verifies the tx is its template + Fulfillment, signs -> "released". Without the officer's approval
//                          the co-signer refuses (escrow_release_not_approved): the agent's Grok check alone releases nothing.
//   cancelMilestoneEscrow() after CancelAfter: EscrowCancel (agent + co-signer); the tokens return to agent_account.
// The agent never holds the preimage before the co-signer decided to release, so a leaked agent key cannot release early.
// Once revealed (inside the co-signed EscrowFinish), any account could submit the fulfillment: the gate is before the reveal.
import { decode, encode, hashes, multisign, TrustSetFlags, type EscrowCreate, type EscrowFinish, type EscrowCancel, type TrustSet } from "xrpl";
import type { Check, Decision, EscrowMilestone, RefusalCode } from "../../../shared/contracts";
import { computeDecisionHash, type DecisionCore } from "../../../shared/hash";
import { COLL, findContract } from "../lib/mongo";
import { nonprofitByEin } from "../lib/registry";
import { explorerTx, hasTrustLine, sourceTag, submitBlobAndWait, tokenBalance, type SubmitResult } from "../lib/xrpl";
import { rippleNow, rippleToIso } from "../lib/credentials";
import { CTT_CURRENCY, CTT_TRUST_LIMIT } from "../lib/governance";
import { escrowMemo, escrowMemoJson, fulfillmentMatches, SIMULATED_ESCROW_LABEL } from "../lib/escrow";
import { canonicalInvoiceId } from "../lib/invoiceId";
import { notEvaluatedChecks } from "../cosigner/checks";
import { verifyInvoice, type ContractTerms, type InvoiceInput } from "../verifier";
import { buildFromProposal } from "./builder";
import { AGENT_RULE_VERSION, clip, isoSeconds, newDecisionId, paymentFor } from "./decision";
import { grokReasoning } from "./pipeline";
import type { AgentCtx } from "./payInvoice";
import type { RecordResult } from "./record";

export const LABEL = SIMULATED_ESCROW_LABEL;

export interface EscrowAttempt {
  decision: Decision;
  milestone: EscrowMilestone | null;
  explorer_url: string | null;
  engine_result: string | null;
  recorded: RecordResult;
  stage: string;
}

type CoReply = { ok: true; signed_blob: string; checks: Check[] } | { ok: false; refusal_reasons?: RefusalCode[]; checks?: Check[]; error?: string; message?: string; problems?: string[] };

async function post(url: string, body: unknown): Promise<{ status: number; j: CoReply & Record<string, unknown> }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const j = (await r.json().catch(() => ({ ok: false, error: "bad_response", message: `HTTP ${r.status}, non-JSON body` }))) as CoReply & Record<string, unknown>;
    return { status: r.status, j };
  } catch (e) {
    return { status: 0, j: { ok: false, error: "cosigner_unavailable", message: `co-signer unreachable at ${url} (${(e as Error).message})` } };
  }
}

const cosignerOf = (blob: string) => (decode(blob) as { Signers?: { Signer: { Account: string } }[] }).Signers?.[0]?.Signer.Account;

/** agent_account's CTT trust line, created by a multisigned TrustSet (agent + co-signer governance). Idempotent. */
export async function ensureAgentCttLine(ctx: AgentCtx): Promise<{ created: boolean; engine_result: string | null; tx_hash: string | null; message: string }> {
  const { client, reg } = ctx;
  if (await hasTrustLine(client, reg.agent_account, reg.city_issuer, CTT_CURRENCY)) return { created: false, engine_result: null, tx_hash: null, message: `agent_account already trusts ${CTT_CURRENCY}/city_issuer` };
  const tx: TrustSet = { TransactionType: "TrustSet", Account: reg.agent_account, LimitAmount: { currency: CTT_CURRENCY, issuer: reg.city_issuer, value: CTT_TRUST_LIMIT }, Flags: TrustSetFlags.tfSetNoRipple };
  const prepared = await ctx.client.autofill(tx, 2);
  const agentBlob = ctx.agentWallet.sign(prepared, true).tx_blob;
  const { status, j } = await post(`${ctx.cosignerUrl}/governance/cosign`, { tx_blob: agentBlob, purpose: "ctt_trust_line" });
  if (!j.ok) throw new Error(`co-signer refused the CTT TrustSet (HTTP ${status}): ${((j.problems as string[] | undefined) ?? [j.message ?? j.error]).join("; ")}`);
  if (cosignerOf(j.signed_blob) !== reg.signers.cosigner.address) throw new Error("the co-signer's TrustSet signature is not from the registry cosigner");
  const blob = multisign([agentBlob, j.signed_blob]);
  const hash = hashes.hashSignedTx(blob);
  const sub = await submitBlobAndWait(client, blob, hash, prepared.LastLedgerSequence!);
  ctx.log(`escrow: agent_account TrustSet ${CTT_CURRENCY}/city_issuer (agent + co-signer via /governance/cosign): ${sub.final} ${sub.validated ? explorerTx(hash) : ""}`);
  if (sub.final !== "tesSUCCESS") throw new Error(`CTT TrustSet failed: ${sub.final}`);
  return { created: true, engine_result: sub.engine_result, tx_hash: hash, message: `created ${explorerTx(hash)}` };
}

export async function agentCttBalance(ctx: AgentCtx): Promise<number> {
  return tokenBalance(ctx.client, ctx.reg.agent_account, ctx.reg.city_issuer, CTT_CURRENCY);
}

function escrowCore(p: { decision_id: string; milestone_id: string; contract_id: string; payee_ein: string; amount: string; reasoning: string; created_at: string }): DecisionCore {
  return {
    decision_id: p.decision_id, invoice_id: p.milestone_id, contract_id: p.contract_id, payee_ein: p.payee_ein, amount: p.amount, currency: "CTT",
    agent_reasoning: clip(`[${LABEL}] ${p.reasoning}`), rule_version: AGENT_RULE_VERSION, source_tag: sourceTag(), created_at: p.created_at,
  };
}

function decisionFrom(core: DecisionCore): Decision {
  return { ...core, outcome: "refused", refusal_reasons: [], checks: [], enforced_by: null, decision_hash: computeDecisionHash(core), xrpl_tx_hash: null, ledger_result: null, signers: [] };
}

async function recordEscrow(ctx: AgentCtx, d: Decision, audit: Record<string, unknown>, explorer?: string | null): Promise<RecordResult> {
  const payment = paymentFor(d, { currency: "CTT", ...(d.xrpl_tx_hash && explorer ? { xrpl_tx_hash: d.xrpl_tx_hash, explorer_url: explorer } : {}) });
  return ctx.recorder.record(d, payment, { label: LABEL, simulated: "escrow of CTT, a city-issued TEST token (RLUSD escrow is impossible on Testnet)", ...audit });
}

function ledgerOutcome(sub: SubmitResult, okOutcome: Decision["outcome"]): Pick<Decision, "outcome" | "refusal_reasons" | "enforced_by" | "ledger_result"> {
  const ok = sub.validated && sub.final === "tesSUCCESS";
  const unknown = sub.status === "unknown";
  return { outcome: ok ? okOutcome : "refused", refusal_reasons: ok ? [] : unknown ? ["ledger_status_unknown"] : ["ledger_rejected"], enforced_by: ok || unknown ? null : "ledger", ledger_result: sub.final };
}

/** Locks `amount` CTT for a milestone of `contract_id` in an escrow only the co-signer's fulfillment can release. */
export async function createMilestoneEscrow(ctx: AgentCtx, opts: { contract_id: string; amount: string; milestone_id?: string; cancel_after_hours?: number; purpose?: string }): Promise<EscrowAttempt> {
  const { client, reg, log } = ctx;
  if (!ctx.db) throw new Error("escrow needs MongoDB");
  const contract = await findContract(ctx.db, opts.contract_id);
  if (!contract) throw new Error(`contract ${opts.contract_id} not found`);
  const hit = nonprofitByEin(reg, contract.nonprofit_ein);
  if (!hit) throw new Error(`no registry wallet for EIN ${contract.nonprofit_ein}`);
  const now = new Date();
  const milestone_id = canonicalInvoiceId(opts.milestone_id ?? `MS-${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`)!;
  const decision_id = newDecisionId(now);
  const created_at = isoSeconds(now);
  const hours = opts.cancel_after_hours ?? 24;
  const cancel_after = rippleNow() + Math.round(hours * 3600);
  const core = escrowCore({
    decision_id, milestone_id, contract_id: contract.contract_id, payee_ein: contract.nonprofit_ein, amount: opts.amount, created_at,
    reasoning:
      `Lock ${opts.amount} ${CTT_CURRENCY} (city test token, not RLUSD) for milestone ${milestone_id} of contract ${contract.contract_id} (${opts.purpose ?? "milestone payment"}), ` +
      `payable only to the registry wallet ${hit.key} ${hit.np.address} for EIN ${contract.nonprofit_ein}. Released only when the co-signer reveals the fulfillment of its PREIMAGE-SHA-256 condition after the milestone is verified; ` +
      `after CancelAfter (${rippleToIso(cancel_after)}) the tokens can only return to agent_account.`,
  });
  const base = decisionFrom(core);
  const refuse = async (codes: RefusalCode[], checks: Check[], stage: string, message: string, extra: Record<string, unknown> = {}): Promise<EscrowAttempt> => {
    const d: Decision = { ...base, refusal_reasons: codes, checks, enforced_by: stage === "cosigner" ? (codes.includes("payee_change_on_hold") ? "hold" : "cosigner") : null, signers: stage === "cosigner" ? ["agent"] : [] };
    const recorded = await recordEscrow(ctx, d, { stage, message, milestone_id, ...extra });
    log(`escrow: create REFUSED at ${stage} (${codes.join(", ")}): ${message}`);
    return { decision: d, milestone: null, explorer_url: null, engine_result: null, recorded, stage };
  };

  // 1. The co-signer issues the condition (and keeps the preimage).
  const cond = await post(`${ctx.cosignerUrl}/escrow/condition`, { milestone_id, decision_id });
  const condition = typeof cond.j.condition === "string" ? cond.j.condition : null;
  if (!cond.j.ok || !condition) return refuse(["cosigner_unavailable"], notEvaluatedChecks("the co-signer issued no condition"), "cosigner_condition", String(cond.j.message ?? cond.j.error ?? `HTTP ${cond.status}`));
  log(`escrow: co-signer issued PREIMAGE-SHA-256 condition ${condition.slice(0, 20)}... for milestone ${milestone_id} (the preimage stays in the co-signer)`);

  // 2. EscrowCreate (agent signs, co-signer checks + co-signs).
  const held = await agentCttBalance(ctx);
  if (held < Number(opts.amount)) return refuse(["agent_balance_insufficient"], notEvaluatedChecks(`agent_account holds ${held} ${CTT_CURRENCY}`), "preflight", `agent_account holds ${held} ${CTT_CURRENCY}, less than ${opts.amount} (run "npm run setup:escrow")`);
  const tx: EscrowCreate = {
    TransactionType: "EscrowCreate", Account: reg.agent_account, Destination: hit.np.address, Amount: { currency: CTT_CURRENCY, issuer: reg.city_issuer, value: opts.amount },
    Condition: condition, CancelAfter: cancel_after, SourceTag: sourceTag(),
    Memos: [escrowMemo({ ms: milestone_id, ctr: contract.contract_id, ein: contract.nonprofit_ein, dh: base.decision_hash, rv: AGENT_RULE_VERSION })],
  };
  const prepared = await client.autofill(tx, 2);
  const agentBlob = ctx.agentWallet.sign(prepared, true).tx_blob;
  log(`escrow: agent signed EscrowCreate ${opts.amount} ${CTT_CURRENCY} -> ${hit.np.address} (${hit.key}), CancelAfter ${rippleToIso(cancel_after)}, Sequence ${prepared.Sequence}; asking the co-signer`);
  const co = await post(`${ctx.cosignerUrl}/escrow/cosign`, { tx_blob: agentBlob, milestone_id, decision_id });
  if (!co.j.ok) {
    const reasons = (co.j.refusal_reasons?.length ? co.j.refusal_reasons : ["cosigner_unavailable"]) as RefusalCode[];
    return refuse(reasons, co.j.checks?.length ? co.j.checks : notEvaluatedChecks(String(co.j.message ?? co.j.error)), "cosigner", String(co.j.message ?? reasons.join(", ")), { http_status: co.status });
  }
  if (cosignerOf(co.j.signed_blob) !== reg.signers.cosigner.address) throw new Error("the co-signer's EscrowCreate signature is not from the registry cosigner");
  const blob = multisign([agentBlob, co.j.signed_blob]);
  const hash = hashes.hashSignedTx(blob);
  const sub = await submitBlobAndWait(client, blob, hash, prepared.LastLedgerSequence!);
  log(`ledger: EscrowCreate ${sub.engine_result} -> ${sub.status}: ${sub.final}`);
  const o = ledgerOutcome(sub, "held_escrow");
  const explorer = sub.validated ? explorerTx(hash) : null;
  const d: Decision = { ...base, ...o, checks: co.j.checks, xrpl_tx_hash: sub.validated || sub.status === "unknown" ? hash : null, signers: ["agent", "cosigner"] };
  const milestone: EscrowMilestone = {
    milestone_id, contract_id: contract.contract_id, payee_ein: contract.nonprofit_ein, destination: hit.np.address, amount: opts.amount, currency: "CTT", issuer: reg.city_issuer,
    condition, cancel_after, cancel_after_iso: rippleToIso(cancel_after), offer_sequence: prepared.Sequence ?? null, status: o.outcome === "held_escrow" ? "held" : "failed",
    create_decision_id: decision_id, create_tx_hash: sub.validated ? hash : null, label: LABEL, is_demo_data: true,
  };
  await ctx.db.collection<EscrowMilestone>(COLL.escrowMilestones).replaceOne({ milestone_id }, { ...milestone }, { upsert: true });
  const recorded = await recordEscrow(ctx, d, { stage: "ledger", milestone_id, tx_hash: hash, engine_result: sub.engine_result, final_result: sub.final, offer_sequence: prepared.Sequence, condition, cancel_after_iso: rippleToIso(cancel_after), memo_json: escrowMemoJson({ ms: milestone_id, ctr: contract.contract_id, ein: contract.nonprofit_ein, dh: base.decision_hash, rv: AGENT_RULE_VERSION }) }, explorer);
  return { decision: d, milestone, explorer_url: explorer, engine_result: sub.engine_result, recorded, stage: "ledger" };
}

/** Verifies the milestone report (Grok verifier + builder), then asks the co-signer to reveal the fulfillment inside a co-signed EscrowFinish. */
export async function releaseMilestoneEscrow(ctx: AgentCtx, milestone_id: string, report: InvoiceInput): Promise<EscrowAttempt> {
  const { client, reg, log } = ctx;
  if (!ctx.db) throw new Error("escrow needs MongoDB");
  const m = await ctx.db.collection<EscrowMilestone>(COLL.escrowMilestones).findOne({ milestone_id }, { projection: { _id: 0 } });
  if (!m) throw new Error(`no escrow milestone ${milestone_id}`);
  const contract = await findContract(ctx.db, m.contract_id);
  const np = contract ? nonprofitByEin(reg, contract.nonprofit_ein) : null;
  const now = new Date();
  const decision_id = newDecisionId(now);
  const created_at = isoSeconds(now);
  const mk = (reasoning: string) => decisionFrom(escrowCore({ decision_id, milestone_id, contract_id: m.contract_id, payee_ein: m.payee_ein, amount: m.amount, reasoning, created_at }));
  const refuse = async (base: Decision, codes: RefusalCode[], checks: Check[], stage: string, message: string, extra: Record<string, unknown> = {}): Promise<EscrowAttempt> => {
    const d: Decision = { ...base, refusal_reasons: codes, checks, enforced_by: stage === "cosigner" ? (codes.includes("payee_change_on_hold") ? "hold" : "cosigner") : null, signers: [] };
    const recorded = await recordEscrow(ctx, d, { stage, message, milestone_id, ...extra });
    log(`escrow: release REFUSED at ${stage} (${codes.join(", ")}): ${message}`);
    return { decision: d, milestone: m, explorer_url: null, engine_result: null, recorded, stage };
  };
  if (m.status !== "held" || m.offer_sequence == null) return refuse(mk(`Milestone ${milestone_id} is ${m.status}; nothing to release.`), ["escrow_not_found"], notEvaluatedChecks(`milestone is ${m.status}`), "agent", `milestone ${milestone_id} is ${m.status}`);

  // 1. Verify the milestone report: Grok (untrusted data, structured proposal only) + the deterministic builder.
  const terms: ContractTerms = {
    contract_id: m.contract_id, agency_code: contract?.agency_code ?? "unknown", payee_ein: contract?.nonprofit_ein ?? "unknown", payee_name: np?.np.name ?? "unknown",
    purpose: contract?.purpose ?? null, start_date: contract?.start_date ?? "unknown", end_date: contract?.end_date ?? "unknown", xrpl_budget_rlusd: contract?.xrpl_budget_rlusd ?? "0", currency: "RLUSD", is_demo_data: true,
  };
  log(`escrow: verifying the milestone report ${report.name} with Grok (untrusted data) + the payment builder`);
  const v = await verifyInvoice(report, terms);
  if (!v.ok) return refuse(mk(`Grok verifier unavailable (${v.message}); failing closed, the fulfillment was not requested.`), ["verifier_unavailable"], notEvaluatedChecks("the verifier failed"), "verifier", v.message);
  const p = v.proposal;
  const b = buildFromProposal(p, { contract_id: m.contract_id, expected_invoice_id: milestone_id, submitted_via: "seed" }, contract, reg, milestone_id, now);
  const problems = b.ok ? [] : b.problems;
  const reasons: RefusalCode[] = b.ok ? [] : [...b.reasons];
  if (Math.round(Number(p.amount) * 1e6) !== Math.round(Number(m.amount) * 1e6)) {
    problems.push(`the report's amount ${p.amount} is not the escrowed ${m.amount}`);
    if (!reasons.includes("verifier_rejected")) reasons.push("verifier_rejected");
  }
  const reasoning = `${grokReasoning(p, v.meta)} Milestone check: ${problems.length ? `REFUSED: ${problems.join("; ")}` : `report ${milestone_id} matches contract ${m.contract_id}, EIN ${m.payee_ein} and the escrowed ${m.amount}`}.`;
  const base = mk(`Release milestone escrow ${milestone_id} (agent_account/${m.offer_sequence}, ${m.amount} ${CTT_CURRENCY} -> ${m.destination}). ${reasoning}`);
  if (reasons.length) return refuse(base, reasons, notEvaluatedChecks("the milestone report was refused before the co-signer was asked"), "payment_builder", problems.join("; "), { proposal: p });
  log(`escrow: milestone report verified (${p.invoice_id}, ${p.amount}, EIN ${p.payee_ein}); asking the co-signer to release`);

  // 2. Unsigned EscrowFinish template; the fee accounts for the 36-byte fulfillment the co-signer will add.
  const tpl: EscrowFinish = { TransactionType: "EscrowFinish", Account: reg.agent_account, Owner: reg.agent_account, OfferSequence: m.offer_sequence, Condition: m.condition, SourceTag: sourceTag() };
  const sized = await client.autofill({ ...tpl, Fulfillment: `A0228020${"00".repeat(32)}` }, 2);
  const template = { ...sized, SigningPubKey: "" } as Record<string, unknown>;
  delete template.Fulfillment;
  const co = await post(`${ctx.cosignerUrl}/escrow/finish`, { tx_blob: encode(template as never), milestone_id, decision_id });
  if (!co.j.ok) {
    const rs = (co.j.refusal_reasons?.length ? co.j.refusal_reasons : ["cosigner_unavailable"]) as RefusalCode[];
    return refuse(base, rs, co.j.checks?.length ? co.j.checks : notEvaluatedChecks(String(co.j.message ?? co.j.error)), "cosigner", String(co.j.message ?? rs.join(", ")), { http_status: co.status });
  }
  // 3. The co-signer's tx must be exactly our template + the Fulfillment (which must satisfy the condition).
  const cosTx = decode(co.j.signed_blob) as Record<string, unknown>;
  if (cosignerOf(co.j.signed_blob) !== reg.signers.cosigner.address) throw new Error("the co-signer's EscrowFinish signature is not from the registry cosigner");
  const bare = { ...cosTx };
  delete bare.Signers;
  const diff = [...new Set([...Object.keys(template), ...Object.keys(bare)])].filter((k) => k !== "Fulfillment" && JSON.stringify(template[k]) !== JSON.stringify(bare[k]));
  if (diff.length || typeof bare.Fulfillment !== "string" || !fulfillmentMatches(m.condition, bare.Fulfillment)) throw new Error(`the co-signer's EscrowFinish differs from the template (${diff.join(", ") || "fulfillment"})`);
  const agentBlob = ctx.agentWallet.sign(bare as unknown as EscrowFinish, true).tx_blob;
  const blob = multisign([agentBlob, co.j.signed_blob]);
  const hash = hashes.hashSignedTx(blob);
  log(`escrow: co-signer co-signed the EscrowFinish with the fulfillment inside (revealed only now); agent signed; submitting ${hash}`);
  const sub = await submitBlobAndWait(client, blob, hash, sized.LastLedgerSequence!);
  log(`ledger: EscrowFinish ${sub.engine_result} -> ${sub.status}: ${sub.final}`);
  const o = ledgerOutcome(sub, "released");
  const explorer = sub.validated ? explorerTx(hash) : null;
  const d: Decision = { ...base, ...o, checks: co.j.checks, xrpl_tx_hash: sub.validated || sub.status === "unknown" ? hash : null, signers: ["agent", "cosigner"] };
  const finished = o.outcome === "released";
  await ctx.db.collection<EscrowMilestone>(COLL.escrowMilestones).updateOne({ milestone_id }, { $set: { ...(finished ? { status: "released" as const } : {}), finish_decision_id: decision_id, ...(sub.validated ? { finish_tx_hash: hash } : {}) } });
  const recorded = await recordEscrow(ctx, d, { stage: "ledger", milestone_id, tx_hash: hash, engine_result: sub.engine_result, final_result: sub.final, offer_sequence: m.offer_sequence, proposal: p, delivered: `${m.amount} ${CTT_CURRENCY} -> ${m.destination}` }, explorer);
  return { decision: d, milestone: { ...m, status: finished ? "released" : m.status }, explorer_url: explorer, engine_result: sub.engine_result, recorded, stage: "ledger" };
}

/** After CancelAfter: EscrowCancel (agent + co-signer); the CTT returns to agent_account. */
export async function cancelMilestoneEscrow(ctx: AgentCtx, milestone_id: string): Promise<EscrowAttempt> {
  const { client, reg, log } = ctx;
  if (!ctx.db) throw new Error("escrow needs MongoDB");
  const m = await ctx.db.collection<EscrowMilestone>(COLL.escrowMilestones).findOne({ milestone_id }, { projection: { _id: 0 } });
  if (!m || m.offer_sequence == null) throw new Error(`no escrow milestone ${milestone_id}`);
  const now = new Date();
  const decision_id = newDecisionId(now);
  const base = decisionFrom(escrowCore({ decision_id, milestone_id, contract_id: m.contract_id, payee_ein: m.payee_ein, amount: m.amount, created_at: isoSeconds(now), reasoning: `Cancel milestone escrow ${milestone_id} after CancelAfter ${m.cancel_after_iso}; the ${m.amount} ${CTT_CURRENCY} return to agent_account.` }));
  const tx: EscrowCancel = { TransactionType: "EscrowCancel", Account: reg.agent_account, Owner: reg.agent_account, OfferSequence: m.offer_sequence, SourceTag: sourceTag() };
  const prepared = await client.autofill(tx, 2);
  const agentBlob = ctx.agentWallet.sign(prepared, true).tx_blob;
  const co = await post(`${ctx.cosignerUrl}/escrow/cosign`, { tx_blob: agentBlob, milestone_id, decision_id });
  if (!co.j.ok) {
    const rs = (co.j.refusal_reasons?.length ? co.j.refusal_reasons : ["cosigner_unavailable"]) as RefusalCode[];
    const d: Decision = { ...base, refusal_reasons: rs, checks: co.j.checks ?? notEvaluatedChecks(String(co.j.message)), enforced_by: "cosigner", signers: ["agent"] };
    const recorded = await recordEscrow(ctx, d, { stage: "cosigner", milestone_id });
    return { decision: d, milestone: m, explorer_url: null, engine_result: null, recorded, stage: "cosigner" };
  }
  const blob = multisign([agentBlob, co.j.signed_blob]);
  const hash = hashes.hashSignedTx(blob);
  const sub = await submitBlobAndWait(client, blob, hash, prepared.LastLedgerSequence!);
  log(`ledger: EscrowCancel ${sub.final}`);
  const ok = sub.validated && sub.final === "tesSUCCESS";
  const d: Decision = { ...base, outcome: "refused", refusal_reasons: ok ? [] : ["ledger_rejected"], checks: co.j.checks, enforced_by: ok ? null : "ledger", xrpl_tx_hash: sub.validated ? hash : null, ledger_result: sub.final, signers: ["agent", "cosigner"] };
  if (ok) await ctx.db.collection<EscrowMilestone>(COLL.escrowMilestones).updateOne({ milestone_id }, { $set: { status: "cancelled" } });
  const recorded = await recordEscrow(ctx, d, { stage: "ledger", milestone_id, tx_hash: hash, final_result: sub.final, note: "cancelled: the tokens returned to agent_account (recorded as outcome refused: nothing was paid)" }, sub.validated ? explorerTx(hash) : null);
  return { decision: d, milestone: m, explorer_url: sub.validated ? explorerTx(hash) : null, engine_result: sub.engine_result, recorded, stage: "ledger" };
}
