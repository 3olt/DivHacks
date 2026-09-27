// Over-limit approvals, OFFICER side (Phase 3, builder B). Used by the officer service (src/officer/server.ts), which
// holds ONLY the officer signer key (weight 1). The officer does not trust the agent's pending record blindly:
//   verifyPending()   re-derives everything from the pending Decision (decision_hash recomputed), the officer's own pinned
//                     accounts.testnet.json (registry wallet for the EIN), the contracts collection AND the co-signer's own
//                     record of the refusal (GET :4002/over-limit/:decision_id: amount, destination, memo dh it saw), and
//                     builds the "approved intent" the officer will sign against. The agent can rewrite `decisions` and
//                     `pending_approvals` consistently (the hash is unkeyed), but not the co-signer's record. The intent
//                     lives in the officer process's memory (not in Mongo), so editing the database after the click cannot
//                     change what gets signed.
//   claimApproval()   single use: pending|failed -> approved, only before expires_at (24 h after the pending decision).
//   matchApprovedTx() PURE: the rebuilt, agent-signed tx must be exactly the approved payment (destination, amount, memo with
//                     the pending dh, RLUSD, SourceTag, field whitelist, fresh Sequence/LastLedgerSequence, only the agent's
//                     valid signature). Anything else -> the officer does not sign.
import { randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import type { Decision, PendingApproval } from "../../../shared/contracts";
import { computeDecisionHash, memoJson, sha256Hex, MEMO_FORMAT, MEMO_TYPE } from "../../../shared/hash";
import { COLL } from "../lib/mongo";
import { nonprofitByEin, type Registry } from "../lib/registry";
import { toHex } from "../lib/xrpl";
import { ALLOWED_FIELDS, AMOUNT_RE, MAX_FEE_DROPS, MAX_LLS_AHEAD, verifySigners } from "../cosigner/checks";
import { toMicro } from "../lib/ledgerScan";

/** How long after the human's click the officer will sign the rebuilt transaction. */
export const SIGN_WINDOW_MS = 10 * 60 * 1000;

export interface ApprovedIntent {
  decision_id: string;
  approval_id: string;
  invoice_id: string;
  contract_id: string;
  payee_ein: string;
  amount: string;
  destination: string;
  decision_hash: string;
  memo_json: string;
  approved_at: string;
  approved_ms: number;
  expires_at: string;
  signed: boolean;
}

export type VerifyOutcome = { ok: true; intent: Omit<ApprovedIntent, "approval_id" | "approved_at" | "approved_ms" | "signed">; notes: string[] } | { ok: false; status: number; error: string; message: string };

/** What the CO-SIGNER recorded when it refused a decision only with over_auto_limit_needs_officer (GET /over-limit/:id). */
export interface CosignerOverLimitRecord {
  ts: string;
  decision_id: string;
  invoice_id: string;
  destination: string;
  amount: string;
  contract_id: string | null;
  payee_ein: string | null;
  dh: string | null;
  memo_sha256: string | null;
}

/** PURE. Problems between a pending approval and the co-signer's own record of the refusal (empty = consistent). The agent
 *  writes both `decisions` and `pending_approvals`, so a consistently rewritten pair (amount changed, hash recomputed) passes
 *  the hash check; it cannot rewrite what the co-signer saw. */
export function cosignerRecordProblems(p: Pick<PendingApproval, "decision_id" | "invoice_id" | "contract_id" | "payee_ein" | "amount" | "destination" | "decision_hash" | "memo_json">, refusals: readonly CosignerOverLimitRecord[] | null): string[] {
  if (!refusals || refusals.length === 0) return [`the co-signer has no record of refusing decision ${p.decision_id} with only over_auto_limit_needs_officer`];
  const out: string[] = [];
  const shapes = new Set(refusals.map((r) => `${toMicro(r.amount)}|${r.destination}|${r.dh}|${r.memo_sha256}`));
  if (shapes.size > 1) out.push(`the co-signer saw ${shapes.size} different transactions for decision ${p.decision_id}; refusing to pick one`);
  const r = refusals[0];
  if (!AMOUNT_RE.test(r.amount) || toMicro(r.amount) !== toMicro(p.amount)) out.push(`amount ${p.amount} is not the ${r.amount} the co-signer refused`);
  if (r.destination !== p.destination) out.push(`destination ${p.destination} is not the ${r.destination} the co-signer saw`);
  if (r.dh !== p.decision_hash) out.push(`decision hash ${p.decision_hash.slice(0, 12)} is not the dh ${String(r.dh).slice(0, 12)} in the memo the co-signer saw`);
  if (r.memo_sha256 !== sha256Hex(p.memo_json)) out.push("the pending memo is not the memo the co-signer saw");
  if (r.contract_id !== p.contract_id || r.payee_ein !== p.payee_ein) out.push(`contract/EIN ${p.contract_id}/${p.payee_ein} differ from the co-signer's ${String(r.contract_id)}/${String(r.payee_ein)}`);
  if (r.invoice_id !== p.invoice_id) out.push(`invoice ${p.invoice_id} is not the ${r.invoice_id} the co-signer saw`);
  return out;
}

export async function verifyPending(db: Db, reg: Registry, decision_id: string, nowMs = Date.now(), cosignerRefusals: readonly CosignerOverLimitRecord[] | null = null): Promise<VerifyOutcome> {
  const p = await db.collection<PendingApproval>(COLL.pendingApprovals).findOne({ decision_id }, { projection: { _id: 0 } });
  if (!p) return { ok: false, status: 404, error: "not_found", message: `no pending approval for decision ${decision_id}` };
  if (p.status === "executed") return { ok: false, status: 409, error: "already_executed", message: `decision ${decision_id} was already executed (${p.executed_decision_id ?? "?"}, ${p.xrpl_tx_hash ?? "?"})` };
  if (p.status === "approved") return { ok: false, status: 409, error: "already_approved", message: `decision ${decision_id} is already approved (${p.approval?.approval_id}); approvals are single-use` };
  if (Date.parse(p.expires_at) <= nowMs || p.status === "expired") {
    await db.collection<PendingApproval>(COLL.pendingApprovals).updateOne({ decision_id, status: { $in: ["pending", "failed"] } }, { $set: { status: "expired" } });
    return { ok: false, status: 410, error: "expired", message: `the approval window for ${decision_id} closed at ${p.expires_at}` };
  }
  const d = await db.collection<Decision>(COLL.decisions).findOne({ decision_id }, { projection: { _id: 0 } });
  if (!d) return { ok: false, status: 404, error: "decision_not_found", message: `decision ${decision_id} is not in the decisions collection` };
  const problems: string[] = [];
  if (d.outcome !== "pending_approval") problems.push(`decision outcome is ${d.outcome}, not pending_approval`);
  if (d.refusal_reasons.join() !== "over_auto_limit_needs_officer") problems.push(`the co-signer's refusal was [${d.refusal_reasons.join(", ")}], not only over_auto_limit_needs_officer`);
  const recomputed = computeDecisionHash(d);
  if (recomputed !== d.decision_hash || d.decision_hash !== p.decision_hash) problems.push(`decision hash mismatch (recomputed ${recomputed.slice(0, 12)}, decision ${d.decision_hash.slice(0, 12)}, pending ${p.decision_hash.slice(0, 12)})`);
  for (const k of ["invoice_id", "contract_id", "payee_ein", "amount"] as const) if (d[k] !== p[k]) problems.push(`${k} differs between the decision (${d[k]}) and the pending record (${p[k]})`);
  if (d.currency !== "RLUSD") problems.push(`currency ${d.currency} is not RLUSD`);
  if (p.memo_json !== memoJson(d)) problems.push("the pending memo is not {inv,ctr,ein,dh,rv} of the pending decision");
  const hit = nonprofitByEin(reg, d.payee_ein);
  if (!hit || hit.np.address !== p.destination) problems.push(`destination ${p.destination} is not the registry wallet ${hit?.np.address ?? "(none)"} for EIN ${d.payee_ein} (officer's pinned accounts.testnet.json)`);
  const contract = await db.collection(COLL.contracts).findOne({ contract_id: d.contract_id }, { projection: { _id: 0, nonprofit_ein: 1 } });
  if (!contract || contract.nonprofit_ein !== d.payee_ein) problems.push(`contract ${d.contract_id} ${contract ? `pays EIN ${String(contract.nonprofit_ein)}` : "is not in the contracts collection"}, not ${d.payee_ein}`);
  for (const x of cosignerRecordProblems(p, cosignerRefusals)) problems.push(`co-signer record: ${x}`);
  if (problems.length) return { ok: false, status: 409, error: "pending_record_invalid", message: problems.join("; ") };
  return {
    ok: true,
    intent: { decision_id, invoice_id: d.invoice_id, contract_id: d.contract_id, payee_ein: d.payee_ein, amount: d.amount, destination: p.destination, decision_hash: d.decision_hash, memo_json: p.memo_json, expires_at: p.expires_at },
    notes: [
      `decision ${decision_id}: ${d.amount} RLUSD to ${hit!.key} ${p.destination} (EIN ${d.payee_ein}) under ${d.contract_id}, invoice ${d.invoice_id}`,
      `decision_hash recomputed = ${recomputed.slice(0, 16)}...; the co-signer refused only over_auto_limit_needs_officer`,
      `the co-signer's own record of that refusal (${cosignerRefusals?.[0]?.ts ?? "?"}) has the same amount, destination, invoice and memo dh`,
    ],
  };
}

/** Single use: pending|failed -> approved (only before expires_at). Returns the approval id, or null if someone else won. */
export async function claimApproval(db: Db, decision_id: string, officer: string, via: string, now = new Date()): Promise<{ approval_id: string; approved_at: string } | null> {
  const approval_id = `apr_${now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}${randomBytes(3).toString("hex")}`;
  const approved_at = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const r = await db.collection<PendingApproval>(COLL.pendingApprovals).updateOne(
    { decision_id, status: { $in: ["pending", "failed"] }, expires_at: { $gt: approved_at } },
    { $set: { status: "approved", approval: { approval_id, officer, approved_at, via } } },
  );
  return r.modifiedCount === 1 ? { approval_id, approved_at } : null;
}

export interface MatchFacts {
  agentAccount: string;
  rlusd: { currency: string; issuer: string };
  sourceTag: number;
  signers: { agent: string; officer: string };
  ledger: { accountSequence: number; validatedLedger: number };
}

/** PURE. Problems with an agent-signed tx the officer is asked to sign for `intent` (empty = exactly the approved payment). */
export function matchApprovedTx(tx: Record<string, unknown>, intent: Pick<ApprovedIntent, "destination" | "amount" | "memo_json">, f: MatchFacts): string[] {
  const p: string[] = [];
  if (tx.TransactionType !== "Payment") p.push(`TransactionType ${String(tx.TransactionType)} is not Payment`);
  if (tx.Account !== f.agentAccount) p.push(`Account ${String(tx.Account)} is not agent_account`);
  if (tx.Destination !== intent.destination) p.push(`Destination ${String(tx.Destination)} is not the approved ${intent.destination}`);
  const a = tx.Amount as { currency?: string; issuer?: string; value?: string } | string | undefined;
  // Compared in integer micro-units: the binary codec writes 30.00 as "30", so a string compare would be wrong.
  const valueOk = typeof a === "object" && !!a && typeof a.value === "string" && AMOUNT_RE.test(a.value) && toMicro(a.value) === toMicro(intent.amount);
  if (typeof a !== "object" || !a || a.currency !== f.rlusd.currency || a.issuer !== f.rlusd.issuer || !valueOk) p.push(`Amount ${JSON.stringify(a ?? null)} is not the approved ${intent.amount} RLUSD`);
  if (tx.SourceTag !== f.sourceTag) p.push(`SourceTag ${String(tx.SourceTag)} is not ${f.sourceTag}`);
  const memos = tx.Memos as { Memo: { MemoType?: string; MemoFormat?: string; MemoData?: string } }[] | undefined;
  const m = Array.isArray(memos) && memos.length === 1 ? memos[0].Memo : null;
  if (!m || String(m.MemoType).toUpperCase() !== toHex(MEMO_TYPE) || String(m.MemoFormat).toUpperCase() !== toHex(MEMO_FORMAT) || String(m.MemoData).toUpperCase() !== toHex(intent.memo_json)) {
    p.push("the memo is not exactly the approved {inv,ctr,ein,dh,rv}");
  }
  const extra = Object.keys(tx).filter((k) => !ALLOWED_FIELDS.has(k));
  if (extra.length) p.push(`fields not allowed: ${extra.join(", ")}`);
  const flags = tx.Flags === undefined ? 0 : Number(tx.Flags);
  if (flags !== 0 && flags !== 0x80000000) p.push(`Flags 0x${flags.toString(16)} not allowed`);
  const fee = typeof tx.Fee === "string" && /^\d+$/.test(tx.Fee) ? Number(tx.Fee) : NaN;
  if (!(fee > 0 && fee <= MAX_FEE_DROPS)) p.push(`Fee ${String(tx.Fee)} outside 1..${MAX_FEE_DROPS} drops`);
  if (tx.SigningPubKey !== "" || tx.TxnSignature !== undefined) p.push("not in multisig form");
  if (tx.Sequence !== f.ledger.accountSequence) p.push(`Sequence ${String(tx.Sequence)} is not agent_account's current Sequence ${f.ledger.accountSequence}`);
  const lls = typeof tx.LastLedgerSequence === "number" ? tx.LastLedgerSequence : NaN;
  if (!(lls > f.ledger.validatedLedger && lls <= f.ledger.validatedLedger + MAX_LLS_AHEAD)) p.push(`LastLedgerSequence ${String(tx.LastLedgerSequence)} not in (${f.ledger.validatedLedger}, ${f.ledger.validatedLedger + MAX_LLS_AHEAD}]`);
  const sigs = verifySigners(tx, f.signers);
  if (sigs.length !== 1 || sigs[0].role !== "agent" || !sigs[0].valid) p.push(`expected exactly the agent's valid signature, got [${sigs.map((s) => `${s.role}${s.valid ? "" : " (invalid)"}`).join(", ")}]`);
  return p;
}
