// Over-limit payments (Phase 3, builder B), AGENT side. Holds only the agent key (weight 1).
//
// 1. payInvoice(): when the co-signer refuses ONLY with over_auto_limit_needs_officer, the agent records the Decision as
//    "pending_approval" and writes a `pending_approvals` document with what is needed to rebuild the same payment
//    (invoice ids, amount, registry destination, the exact memo JSON with the pending decision's dh). No signature is stored.
// 2. The human officer approves it on the officer service (POST :4004/approvals/:decision_id). The officer verifies the
//    pending decision itself, claims it (single use, 24 h expiry) and calls the xrpl service, which runs executeApproved():
//    rebuild the payment FRESH (new Sequence / LastLedgerSequence, same memo and dh) -> agent signs -> the OFFICER signs only
//    if the tx matches what it approved exactly -> the CO-SIGNER verifies the officer signature (check 5) and signs ->
//    submit: a 3-signer (agent + officer + co-signer) payment. A NEW Decision records it (audit.approved_from = the pending
//    decision); the pending one is marked resolved.
// The agent cannot finish this alone: without the officer's signature the co-signer refuses (check 5), and the ledger
// needs quorum 3 in any case.
import { decode, hashes, multisign, type Payment as XrplPayment } from "xrpl";
import type { Db } from "mongodb";
import type { Decision, Invoice, PendingApproval, RefusalCode } from "../../../shared/contracts";
import { MEMO_FORMAT, MEMO_TYPE, memoHash, type PaymentMemo } from "../../../shared/hash";
import { COLL } from "../lib/mongo";
import { nonprofitByEin } from "../lib/registry";
import { explorerTx, rlusd, sourceTag, submitBlobAndWait, tokenBalance, toHex } from "../lib/xrpl";
import { notEvaluatedChecks } from "../cosigner/checks";
import { clip, decisionCore, isoSeconds, newDecisionId, paymentFor, baseDecision } from "./decision";
import { requestCosign, type AgentCtx } from "./payInvoice";

export const APPROVAL_TTL_HOURS = 24;

export async function createPendingApproval(
  db: Db,
  p: { decision: Decision; invoice: Invoice; destination: string; memo_json: string; cosigner_refusal: string[]; now?: Date },
): Promise<PendingApproval> {
  const now = p.now ?? new Date();
  const doc: PendingApproval = {
    decision_id: p.decision.decision_id,
    status: "pending",
    created_at: isoSeconds(now),
    expires_at: isoSeconds(new Date(now.getTime() + APPROVAL_TTL_HOURS * 3600e3)),
    invoice_id: p.invoice.invoice_id,
    contract_id: p.invoice.contract_id,
    payee_ein: p.invoice.payee_ein,
    amount: p.invoice.amount,
    currency: "RLUSD",
    destination: p.destination,
    decision_hash: p.decision.decision_hash,
    memo_json: p.memo_json,
    cosigner_refusal: p.cosigner_refusal,
    is_demo_data: true,
  };
  await db.collection<PendingApproval>(COLL.pendingApprovals).replaceOne({ decision_id: doc.decision_id }, { ...doc }, { upsert: true });
  return doc;
}

export async function listPendingApprovals(db: Db, status?: string): Promise<PendingApproval[]> {
  return db
    .collection<PendingApproval>(COLL.pendingApprovals)
    .find(status ? { status: status as PendingApproval["status"] } : {}, { projection: { _id: 0 } })
    .sort({ created_at: -1 })
    .limit(50)
    .toArray();
}

export interface ExecuteResult {
  ok: boolean;
  status: number;
  error?: string;
  message: string;
  decision?: Decision;
  explorer_url?: string | null;
  engine_result?: string | null;
}

/** POST /officer/approvals/:decision_id/sign on the officer service. Never throws. */
async function requestOfficerSignature(officerUrl: string, decision_id: string, body: { tx_blob: string; approval_id: string }): Promise<{ ok: true; signed_blob: string } | { ok: false; status: number; message: string }> {
  try {
    const r = await fetch(`${officerUrl}/approvals/${encodeURIComponent(decision_id)}/sign`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; signed_blob?: string; message?: string; problems?: string[] };
    if (r.ok && j.ok && typeof j.signed_blob === "string") return { ok: true, signed_blob: j.signed_blob };
    return { ok: false, status: r.status, message: j.message ?? ((j.problems ?? []).join("; ") || `HTTP ${r.status}`) };
  } catch (e) {
    return { ok: false, status: 0, message: `officer service at ${officerUrl} unreachable (${(e as Error).message})` };
  }
}

/** Rebuilds an officer-approved over-limit payment fresh and submits it with agent + officer + co-signer signatures. */
export async function executeApproved(decision_id: string, approval_id: unknown, ctx: AgentCtx, officerUrl: string): Promise<ExecuteResult> {
  const { client, reg, log } = ctx;
  if (!ctx.db) return { ok: false, status: 503, error: "no_database", message: "MongoDB is not reachable" };
  const db = ctx.db;
  const coll = db.collection<PendingApproval>(COLL.pendingApprovals);
  const p = await coll.findOne({ decision_id }, { projection: { _id: 0 } });
  if (!p) return { ok: false, status: 404, error: "not_found", message: `no pending approval for decision ${decision_id}` };
  if (p.status !== "approved" || !p.approval || p.approval.approval_id !== approval_id) {
    return { ok: false, status: 409, error: "not_approved", message: `decision ${decision_id} is ${p.status}${p.approval ? ` (approval ${p.approval.approval_id})` : ""}; the officer must approve it first (POST $OFFICER_URL/approvals/${decision_id})` };
  }
  if (Date.parse(p.expires_at) <= Date.now()) return { ok: false, status: 410, error: "expired", message: `the approval window for ${decision_id} closed at ${p.expires_at}` };

  // Agent-side sanity (the officer and the co-signer check this independently): registry destination, memo = pending dh.
  const hit = nonprofitByEin(reg, p.payee_ein);
  let memo: PaymentMemo | null = null;
  try {
    memo = JSON.parse(p.memo_json) as PaymentMemo;
  } catch {
    memo = null;
  }
  if (!hit || hit.np.address !== p.destination) return { ok: false, status: 409, error: "destination_changed", message: `the registry wallet for EIN ${p.payee_ein} is ${hit?.np.address ?? "none"}, not ${p.destination}` };
  if (!memo || memo.dh !== p.decision_hash || memo.inv !== p.invoice_id || memo.ctr !== p.contract_id || memo.ein !== p.payee_ein) {
    return { ok: false, status: 409, error: "bad_pending_record", message: "the pending record's memo does not match its decision hash / invoice" };
  }

  const R = rlusd();
  const tag = sourceTag();
  const now = new Date();
  const new_id = newDecisionId(now);
  const created_at = isoSeconds(now);
  const reasoning = clip(
    `Officer-approved execution of pending decision ${decision_id} (${p.amount} RLUSD > AUTO_LIMIT; approval ${p.approval.approval_id} by ${p.approval.officer} at ${p.approval.approved_at}). ` +
      `Rebuilt fresh (new Sequence/LastLedgerSequence) with the SAME memo: inv ${p.invoice_id}, dh ${p.decision_hash} (the pending decision's hash). ` +
      `Signatures: agent (weight 1) + officer (weight 1, signs only the exact approved payment) + co-signer (weight 2, all 8 checks incl. the officer signature).`,
  );
  const invoiceLike = { invoice_id: p.invoice_id, contract_id: p.contract_id, payee_ein: p.payee_ein, amount: p.amount };
  const core = decisionCore(invoiceLike, new_id, created_at, reasoning, tag);
  // The on-ledger memo commits to the PENDING decision (what the officer approved), so this record carries that hash.
  const base: Decision = { ...baseDecision(core), decision_hash: p.decision_hash };
  const memo_hash = memoHash(p.memo_json);
  const auditBase = { stage: "officer_approved_execution", approved_from: decision_id, approval_id: p.approval.approval_id, approved_by: p.approval.officer, memo_json: p.memo_json, destination: p.destination, dh_note: "decision_hash = the pending decision's hash (approved_from); the on-ledger memo commits to it" };

  const record = async (d: Decision, extra: Record<string, unknown>, paymentExtra: Record<string, unknown> = {}): Promise<Decision> => {
    await ctx.recorder.record(d, paymentFor(d, { memo_hash, ...paymentExtra }), { ...auditBase, ...extra });
    return d;
  };
  const settle = async (status: PendingApproval["status"], d: Decision, extra: Record<string, unknown> = {}) => {
    await coll.updateOne({ decision_id }, { $set: { status, executed_decision_id: d.decision_id, ...(d.xrpl_tx_hash ? { xrpl_tx_hash: d.xrpl_tx_hash } : {}), ...(d.ledger_result ? { ledger_result: d.ledger_result } : {}), ...extra } });
    await db.collection(COLL.decisions).updateOne(
      { decision_id },
      { $set: { "audit.approval": { status, executed_decision_id: d.decision_id, xrpl_tx_hash: d.xrpl_tx_hash, ledger_result: d.ledger_result, resolved_at: isoSeconds() } } },
    );
    // The pending decision's Payment row (status "pending_approval") points at the attempt that executed it, so a money
    // trail does not show the same amount twice (filter rows with superseded_by / approval_status "executed").
    await db.collection(COLL.payments).updateOne(
      { payment_id: paymentFor({ ...base, decision_id } as Decision).payment_id },
      { $set: { approval_status: status, superseded_by: paymentFor(d).payment_id, ...(d.xrpl_tx_hash && status === "executed" ? { settled_by_tx: d.xrpl_tx_hash } : {}) } },
    );
  };
  const refuse = async (codes: RefusalCode[], why: string, extra: Record<string, unknown>, signers: string[], checks = notEvaluatedChecks(why)): Promise<ExecuteResult> => {
    const d = await record({ ...base, refusal_reasons: codes, checks, enforced_by: codes.includes("officer_approval_invalid") ? null : "cosigner", signers }, { ...extra, error: why });
    await settle("failed", d, { failure: why.slice(0, 300) });
    log(`approvals: execution of ${decision_id} REFUSED (${codes.join(", ")}): ${why}`);
    return { ok: false, status: 422, error: codes[0], message: why, decision: d };
  };

  // Rebuild fresh.
  const held = await tokenBalance(client, reg.agent_account, R.issuer, R.currency);
  if (held < Number(p.amount)) return refuse(["agent_balance_insufficient"], `agent_account holds ${held} RLUSD, less than ${p.amount}; run "npm run setup:xrpl"`, {}, []);
  const tx: XrplPayment = {
    TransactionType: "Payment", Account: reg.agent_account, Destination: p.destination, Amount: { currency: R.currency, issuer: R.issuer, value: p.amount }, SourceTag: tag,
    Memos: [{ Memo: { MemoType: toHex(MEMO_TYPE), MemoFormat: toHex(MEMO_FORMAT), MemoData: toHex(p.memo_json) } }],
  };
  const prepared = await client.autofill(tx, 3);
  const lls = prepared.LastLedgerSequence!;
  const agentBlob = ctx.agentWallet.sign(prepared, true).tx_blob;
  log(`approvals: rebuilt ${decision_id} fresh: ${p.amount} RLUSD -> ${p.destination}, Sequence ${prepared.Sequence}, LastLedgerSequence ${lls}; agent signed; asking the officer to sign the exact approved payment`);

  const off = await requestOfficerSignature(officerUrl, decision_id, { tx_blob: agentBlob, approval_id: p.approval.approval_id });
  if (!off.ok) return refuse(["officer_approval_invalid"], `the officer did not sign (HTTP ${off.status || "none"}): ${off.message}`, { officer_status: off.status }, ["agent"]);
  const officerSigner = (decode(off.signed_blob) as { Signers?: { Signer: { Account: string } }[] }).Signers?.[0]?.Signer.Account;
  if (officerSigner !== reg.signers.officer.address) return refuse(["officer_approval_invalid"], `the officer service returned a signature from ${officerSigner}, not the registry officer`, {}, ["agent"]);
  const withOfficer = multisign([agentBlob, off.signed_blob]);
  log(`approvals: officer ${officerSigner} signed; asking the co-signer (it verifies the officer signature itself, check 5)`);

  const { status, cos } = await requestCosign(ctx.cosignerUrl, { tx_blob: withOfficer, invoice_id: p.invoice_id, decision_id: new_id });
  if (!cos.ok) {
    const transport = !cos.refusal_reasons?.length;
    return refuse((transport ? ["cosigner_unavailable"] : cos.refusal_reasons) as RefusalCode[], cos.message ?? `co-signer HTTP ${status}`, { http_status: status }, ["agent", "officer"], cos.checks?.length ? cos.checks : undefined);
  }
  const cosSigner = (decode(cos.signed_blob) as { Signers?: { Signer: { Account: string } }[] }).Signers?.[0]?.Signer.Account;
  if (cosSigner !== reg.signers.cosigner.address) return refuse(["cosigner_unavailable"], `the co-signer returned a signature from ${cosSigner}`, {}, ["agent", "officer"]);
  const combined = multisign([withOfficer, cos.signed_blob]);
  const hash = hashes.hashSignedTx(combined);
  const nSig = ((decode(combined) as { Signers?: unknown[] }).Signers ?? []).length;
  log(`approvals: co-signer SIGNED; submitting ${hash} with ${nSig} signatures (agent + officer + co-signer)`);
  const sub = await submitBlobAndWait(client, combined, hash, lls);
  log(`ledger: engine_result ${sub.engine_result} -> ${sub.status}: ${sub.final}`);
  const released = sub.validated && sub.final === "tesSUCCESS";
  const unknown = sub.status === "unknown";
  const d: Decision = {
    ...base,
    outcome: released ? "released" : "refused",
    refusal_reasons: released ? [] : unknown ? ["ledger_status_unknown"] : ["ledger_rejected"],
    checks: cos.checks,
    enforced_by: released || unknown ? null : "ledger",
    xrpl_tx_hash: sub.validated || unknown ? hash : null,
    ledger_result: sub.final,
    signers: ["agent", "cosigner", "officer"],
  };
  const explorer_url = sub.validated || unknown ? explorerTx(hash) : null;
  await record(
    d,
    { tx_hash: hash, engine_result: sub.engine_result, final_result: sub.final, submit_status: sub.status, last_ledger_sequence: lls, signer_count: nSig, delivered_amount: (sub.meta as { delivered_amount?: unknown } | undefined)?.delivered_amount ?? null, fee_drops: prepared.Fee },
    { date: sub.close_time_iso ?? created_at, ...(explorer_url ? { xrpl_tx_hash: hash, explorer_url } : {}) },
  );
  await settle(released ? "executed" : "failed", d);
  return { ok: released, status: released ? 200 : 422, message: released ? `released with 3 signatures: ${explorerTx(hash)}` : `ledger ${sub.final}`, decision: d, explorer_url, engine_result: sub.engine_result };
}
