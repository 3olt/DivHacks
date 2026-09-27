// Co-signer routes added in Phase 3 by builder B: governance (kill switch, CTT trust line) and the SIMULATED escrow.
// Registered by server.ts; runs inside the co-signer process (COSIGNER_SEED only), with the same pinned registry, contract
// terms, hold record and serial queue as /cosign.
//
//   POST /governance/cosign {tx_blob, purpose: "revoke_agent"|"restore_agent"|"ctt_trust_line"}
//        200 {ok, signer:"cosigner", signer_address, signed_blob, purpose, detail, signer_list_now}
//        422 {ok:false, error:"governance_refused", problems}     (nothing signed)
//        Only a SignerListSet to EXACTLY REVOKED {cosigner:2, officer:1} or CANONICAL {agent:1, cosigner:2, officer:1}
//        (quorum 3, officer signature required, agent signature refused), or a TrustSet for exactly CTT/city_issuer.
//   POST /escrow/condition {milestone_id, decision_id}
//        200 {ok, milestone_id, condition, condition_type:"PREIMAGE-SHA-256", issued_at, reused}
//        The preimage stays in xrpl/data/cosigner-escrow.local.jsonl (gitignored, this process only): never in Mongo,
//        logs or any response.
//   POST /escrow/cosign {tx_blob, milestone_id, decision_id}     EscrowCreate or EscrowCancel signed by the agent
//        200 {ok, signed_blob, checks} | 422 {ok:false, refusal_reasons, checks}
//   POST /escrow/release-approval {approval: MilestoneReleaseApproval}      (the OFFICER service, after the human's click)
//        200 {ok, milestone_id, accepted_at} if the officer signature verifies and the approval is bound to the escrow this
//        co-signer co-signed for the milestone; 422 {ok:false, error:"release_approval_rejected", message}
//   POST /escrow/finish {tx_blob, milestone_id, decision_id}     UNSIGNED EscrowFinish template
//        200 {ok, signed_blob (now carrying the Fulfillment), checks} | 422 {ok:false, refusal_reasons, checks}
//        Only with a valid, unused officer release approval for that on-ledger escrow and a CANONICAL signer list.
//   GET  /escrow -> {ok, label, milestones:[{milestone_id, condition, create, finish, cancel, release_approved}]}   (no preimages)
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { decode, type Client, type Transaction, type Wallet } from "xrpl";
import type { Db } from "mongodb";
import type { MilestoneReleaseApproval } from "../../../shared/contracts";
import { paths } from "../env";
import type { Registry } from "../lib/registry";
import type { RegistrySnapshot } from "../lib/registrySnapshot";
import { readRegistrySnapshot } from "../lib/registrySnapshot";
import type { ContractResolver } from "../lib/contractPins";
import type { HoldBook } from "../lib/holds";
import { readCredential } from "../lib/credentials";
import { accountState } from "../lib/xrpl";
import { readLedgerView, type PolicyInputs } from "./context";
import { checkGovernanceTx, classifySignerList, GOVERNANCE_RULE_VERSION } from "../lib/governance";
import {
  checkEscrowCancel, checkEscrowCreate, checkEscrowFinish, conditionFromPreimage, newPreimage, parseEscrowMemo, verifyReleaseApproval,
  ESCROW_RULE_VERSION, SIMULATED_ESCROW_LABEL, type EscrowEntry, type EscrowFacts,
} from "../lib/escrow";

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const BLOB_RE = /^[0-9A-Fa-f]{2,20000}$/;

interface ExtraDeps {
  app: FastifyInstance;
  wallet: Wallet;
  policy: PolicyInputs;
  registryFile: Registry;
  pinned: RegistrySnapshot;
  resolveContract: ContractResolver;
  holdBook: HoldBook;
  db: Db;
  xrplClient: () => Promise<Client>;
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
  logLine: (fields: Record<string, unknown>) => void;
}

type EscrowEvent =
  | { type: "condition"; at: string; milestone_id: string; decision_id: string; condition: string; preimage: string }
  | { type: "create_signed" | "cancel_signed"; at: string; milestone_id: string; decision_id: string; sequence: number; last_ledger_sequence: number; offer_sequence?: number; destination?: string; amount?: string; ctr?: string; ein?: string; cancel_after?: number }
  | { type: "finish_signed"; at: string; milestone_id: string; decision_id: string; sequence: number; last_ledger_sequence: number; offer_sequence: number; release_approval_signature?: string }
  | { type: "release_approved"; at: string; milestone_id: string; approval: MilestoneReleaseApproval };

/** The co-signer's own escrow record (append-only JSONL; holds the preimages; path not configurable). */
class EscrowBook {
  conditions = new Map<string, Extract<EscrowEvent, { type: "condition" }>>();
  creates = new Map<string, Extract<EscrowEvent, { type: "create_signed" | "cancel_signed" }>>();
  cancels = new Map<string, Extract<EscrowEvent, { type: "create_signed" | "cancel_signed" }>>();
  finishes = new Map<string, Extract<EscrowEvent, { type: "finish_signed" }>>();
  /** The latest officer release approval per milestone, and the signatures of approvals already used for a finish. */
  releases = new Map<string, Extract<EscrowEvent, { type: "release_approved" }>>();
  usedApprovals = new Set<string>();
  constructor(private file: string) {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
      try {
        this.apply(JSON.parse(line) as EscrowEvent);
      } catch {
        /* skip unreadable line */
      }
    }
  }
  private apply(e: EscrowEvent) {
    if (e.type === "condition") this.conditions.set(e.milestone_id, e);
    else if (e.type === "create_signed") this.creates.set(e.milestone_id, e);
    else if (e.type === "cancel_signed") this.cancels.set(e.milestone_id, e);
    else if (e.type === "finish_signed") {
      this.finishes.set(e.milestone_id, e);
      if (e.release_approval_signature) this.usedApprovals.add(e.release_approval_signature);
    } else if (e.type === "release_approved") this.releases.set(e.milestone_id, e);
  }
  /** Written BEFORE anything leaves the process; throws if it cannot be written. */
  append(e: EscrowEvent) {
    fs.appendFileSync(this.file, JSON.stringify(e) + "\n");
    this.apply(e);
  }
  list() {
    return [...this.conditions.values()].map((c) => ({
      milestone_id: c.milestone_id,
      decision_id: c.decision_id,
      condition: c.condition,
      issued_at: c.at,
      create: this.creates.get(c.milestone_id) ?? null,
      finish: this.finishes.get(c.milestone_id) ?? null,
      cancel: this.cancels.get(c.milestone_id) ?? null,
      release_approved: ((r) => (r ? { ts: r.approval.ts, signer: r.approval.signer, accepted_at: r.at, used: this.usedApprovals.has(r.approval.signature) } : null))(this.releases.get(c.milestone_id)),
    }));
  }
}

async function readEscrow(client: Client, owner: string, seq: number, ledger_index: number): Promise<EscrowEntry> {
  try {
    const r = (await client.request({ command: "ledger_entry", escrow: { owner, seq }, ledger_index } as never)) as {
      result: { node: { Destination: string; Amount: { currency?: string; issuer?: string; value?: string } | string; Condition?: string; CancelAfter?: number; FinishAfter?: number } };
    };
    const n = r.result.node;
    return { found: true, owner, seq, destination: n.Destination, amount: n.Amount, condition: n.Condition ?? null, cancel_after: n.CancelAfter ?? null, finish_after: n.FinishAfter ?? null };
  } catch (e) {
    const err = (e as { data?: { error?: string } }).data?.error;
    if (err === "entryNotFound" || err === "malformedRequest" || err === "invalidParams") return { found: false, owner, seq };
    throw e;
  }
}

export function registerExtraRoutes(d: ExtraDeps): { governanceLog: string; escrowLog: string; escrowBook: EscrowBook } {
  const { app, wallet, policy, registryFile } = d;
  const govPath = path.join(paths.dataDir, "cosigner-governance.local.jsonl");
  const escrowPath = path.join(paths.dataDir, "cosigner-escrow.local.jsonl");
  const book = new EscrowBook(escrowPath);
  const signers = { agent: registryFile.signers.agent.address, cosigner: registryFile.signers.cosigner.address, officer: registryFile.signers.officer.address };
  const scrub = (m: string) => m.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>");
  const exact = (body: unknown, keys: string): Record<string, unknown> | null =>
    body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).sort().join(",") === keys ? (body as Record<string, unknown>) : null;
  const bad = (reply: FastifyReply, message: string) => reply.code(400).send({ ok: false, error: "bad_request", message });
  const unavailable = (reply: FastifyReply, e: unknown) => reply.code(503).send({ ok: false, error: "ledger_unavailable", message: scrub((e as Error).message) });

  /** Signs the SAME transaction (Signers stripped) in multisig form. */
  const cosign = (tx: Record<string, unknown>): string => {
    const t = { ...tx };
    delete t.Signers;
    return wallet.sign(t as unknown as Transaction, true).tx_blob;
  };

  // ---------------------------------------------------------------- governance
  app.post("/governance/cosign", (req, reply) =>
    d.serial(async () => {
      const body = exact(req.body, "purpose,tx_blob");
      if (!body) return bad(reply, "body must contain exactly {tx_blob, purpose}");
      if (typeof body.tx_blob !== "string" || !BLOB_RE.test(body.tx_blob)) return bad(reply, "tx_blob must be a hex string");
      let tx: Record<string, unknown>;
      try {
        tx = decode(body.tx_blob) as Record<string, unknown>;
      } catch (e) {
        return bad(reply, `tx_blob does not decode: ${(e as Error).message}`);
      }
      let client: Client;
      let lv: Awaited<ReturnType<typeof readLedgerView>>;
      let now: string;
      try {
        client = await d.xrplClient();
        lv = await readLedgerView(client, policy.agentAccount);
        now = classifySignerList((await accountState(client, policy.agentAccount)).signerList, signers);
      } catch (e) {
        return unavailable(reply, e);
      }
      const r = checkGovernanceTx(tx, body.purpose, { agentAccount: policy.agentAccount, cityIssuer: policy.credentialIssuer, signers, ledger: { accountSequence: lv.accountSequence, validatedLedger: lv.validatedLedger } });
      if (!r.ok) {
        d.logLine({ governance: body.purpose, result: "refused", problems: r.problems, signer_list_now: now });
        return reply.code(422).send({ ok: false, error: "governance_refused", rule_version: GOVERNANCE_RULE_VERSION, problems: r.problems, signer_list_now: now });
      }
      let signed_blob: string;
      try {
        signed_blob = cosign(tx);
      } catch (e) {
        return bad(reply, `transaction failed validation: ${(e as Error).message}`);
      }
      try {
        fs.appendFileSync(govPath, JSON.stringify({ ts: new Date().toISOString(), purpose: r.purpose, sequence: tx.Sequence, last_ledger_sequence: tx.LastLedgerSequence, signer_list_before: now }) + "\n");
      } catch (e) {
        return reply.code(500).send({ ok: false, error: "record_write_failed", message: (e as Error).message });
      }
      d.logLine({ governance: r.purpose, result: "signed", sequence: tx.Sequence, signer_list_now: now, detail: r.detail });
      return reply.send({ ok: true, signer: "cosigner", signer_address: wallet.address, signed_blob, purpose: r.purpose, detail: r.detail, signer_list_now: now, rule_version: GOVERNANCE_RULE_VERSION });
    }),
  );

  // ---------------------------------------------------------------- escrow (SIMULATED: CTT test token, not RLUSD)
  app.get("/escrow", async () => ({ ok: true, label: SIMULATED_ESCROW_LABEL, rule_version: ESCROW_RULE_VERSION, milestones: book.list() }));

  app.post("/escrow/condition", (req, reply) =>
    d.serial(async () => {
      const body = exact(req.body, "decision_id,milestone_id");
      if (!body) return bad(reply, "body must contain exactly {milestone_id, decision_id}");
      const { milestone_id, decision_id } = body as { milestone_id: unknown; decision_id: unknown };
      if (typeof milestone_id !== "string" || !ID_RE.test(milestone_id) || typeof decision_id !== "string" || !ID_RE.test(decision_id)) return bad(reply, "milestone_id / decision_id must match [A-Za-z0-9_.:-]{1,128}");
      const prev = book.conditions.get(milestone_id);
      if (prev) return reply.send({ ok: true, milestone_id, condition: prev.condition, condition_type: "PREIMAGE-SHA-256", issued_at: prev.at, reused: true });
      const preimage = newPreimage();
      const { condition } = conditionFromPreimage(preimage);
      try {
        book.append({ type: "condition", at: new Date().toISOString(), milestone_id, decision_id, condition, preimage });
      } catch (e) {
        return reply.code(500).send({ ok: false, error: "record_write_failed", message: (e as Error).message });
      }
      d.logLine({ escrow: "condition_issued", milestone_id, decision_id, condition: `${condition.slice(0, 16)}...` });
      return reply.send({ ok: true, milestone_id, condition, condition_type: "PREIMAGE-SHA-256", issued_at: new Date().toISOString(), reused: false });
    }),
  );

  /** Everything checkEscrow* needs, read by the co-signer itself. */
  async function escrowFacts(tx: Record<string, unknown>, ms: string, destination: string, ctr: string | null): Promise<EscrowFacts> {
    const client = await d.xrplClient();
    const lv = await readLedgerView(client, policy.agentAccount);
    const at = { ledger_index: lv.validatedLedger, close_time: lv.closeTime };
    const credential = await readCredential(client, destination, policy.credentialIssuer, at);
    const c = ctr ? await d.resolveContract(ctr) : { contract: null, missing: "no contract id for this milestone", drift: null, note: null };
    const fresh = await readRegistrySnapshot(d.db);
    const nowMs = Date.now();
    await d.holdBook.refresh(d.db, nowMs);
    const holds = d.holdBook.active(nowMs, (ein) => d.pinned.byEin.get(ein)?.address);
    const f: EscrowFacts = {
      agentAccount: policy.agentAccount, cityIssuer: policy.credentialIssuer, sourceTag: policy.sourceTag, signerAddresses: policy.signerAddresses,
      maxAmount: policy.autoLimit, ledger: { accountSequence: lv.accountSequence, validatedLedger: lv.validatedLedger, closeTime: lv.closeTime },
      issuedCondition: book.conditions.get(ms)?.condition ?? null, registry: d.pinned,
      registryDrift: fresh.sha256 !== d.pinned.sha256 ? `pinned ${d.pinned.sha256.slice(0, 12)} vs database now ${fresh.sha256.slice(0, 12)}` : null,
      allowlist: policy.allowlist, contract: c.contract, contractMissing: c.missing, contractDrift: c.drift, credential, holds, exclusions: policy.exclusions,
    };
    const prevCreate = book.creates.get(ms);
    if (tx.TransactionType === "EscrowCreate" && prevCreate) {
      // One escrow per milestone: refused while an earlier create co-signature can still land, or once it landed (the
      // escrow exists, or was finished / cancelled). A create that expired unlanded may be retried.
      if (prevCreate.last_ledger_sequence >= lv.validatedLedger) f.priorCreate = `an EscrowCreate co-signature for milestone ${ms} is still live until ledger ${prevCreate.last_ledger_sequence}`;
      else if (book.finishes.has(ms) || book.cancels.has(ms) || (await readEscrow(client, policy.agentAccount, prevCreate.sequence, lv.validatedLedger)).found) {
        f.priorCreate = `milestone ${ms} was already escrowed (agent_account/${prevCreate.sequence})`;
      }
    }
    if (tx.TransactionType === "EscrowFinish" || tx.TransactionType === "EscrowCancel") {
      const off = typeof tx.OfferSequence === "number" ? tx.OfferSequence : -1;
      f.escrow = off >= 0 ? await readEscrow(client, policy.agentAccount, off, lv.validatedLedger) : { found: false, owner: policy.agentAccount, seq: off };
      f.recordedOfferSequence = prevCreate?.sequence ?? null;
      const prevFinish = book.finishes.get(ms);
      if (prevFinish && prevFinish.last_ledger_sequence >= lv.validatedLedger) f.priorFinish = `an EscrowFinish co-signature for milestone ${ms} is still live until ledger ${prevFinish.last_ledger_sequence}`;
    }
    if (tx.TransactionType === "EscrowFinish") {
      const rel = book.releases.get(ms);
      f.releaseApproval = { approval: rel?.approval ?? null, used: !!rel && book.usedApprovals.has(rel.approval.signature), officerAddress: registryFile.signers.officer.address, nowMs: Date.now() };
      f.signerList = classifySignerList((await accountState(client, policy.agentAccount)).signerList, signers);
    }
    return f;
  }

  // The officer service delivers the officer's signed release approval here (after the human's click). Verified against the
  // pinned officer key and bound to the escrow THIS co-signer co-signed for the milestone (its own record, not the caller's).
  app.post("/escrow/release-approval", (req, reply) =>
    d.serial(async () => {
      const body = exact(req.body, "approval");
      if (!body || !body.approval || typeof body.approval !== "object") return bad(reply, "body must contain exactly {approval}");
      const a = body.approval as MilestoneReleaseApproval;
      const ms = typeof a.milestone_id === "string" && ID_RE.test(a.milestone_id) ? a.milestone_id : null;
      if (!ms) return bad(reply, "approval.milestone_id must match [A-Za-z0-9_.:-]{1,128}");
      const rec = book.creates.get(ms);
      const cond = book.conditions.get(ms);
      const reject = (message: string) => {
        d.logLine({ escrow: "release_approval", milestone_id: ms, result: "rejected", why: message });
        return reply.code(422).send({ ok: false, error: "release_approval_rejected", message });
      };
      if (!rec || !cond || typeof rec.sequence !== "number" || !rec.destination || !rec.amount) return reject(`the co-signer has no EscrowCreate record for milestone ${ms}`);
      // (A new approval after a used one is accepted: e.g. the earlier finish co-signature expired without landing.)
      const v =verifyReleaseApproval(a, { milestone_id: ms, owner: policy.agentAccount, offer_sequence: rec.sequence, condition: cond.condition, destination: rec.destination, amount: rec.amount, issuer: policy.credentialIssuer }, registryFile.signers.officer.address);
      if (!v.ok) return reject(v.why ?? "invalid approval");
      if (book.usedApprovals.has(a.signature)) return reject("this approval was already used for a finish co-signature (single use)");
      const at = new Date().toISOString();
      try {
        book.append({ type: "release_approved", at, milestone_id: ms, approval: a });
      } catch (e) {
        return reply.code(500).send({ ok: false, error: "record_write_failed", message: (e as Error).message });
      }
      d.logLine({ escrow: "release_approval", milestone_id: ms, result: "accepted", officer: a.signer, ts: a.ts, offer_sequence: a.offer_sequence });
      return reply.send({ ok: true, milestone_id: ms, accepted_at: at, offer_sequence: rec.sequence });
    }),
  );

  const escrowBody = (req: { body: unknown }): { tx: Record<string, unknown>; ms: string; decision_id: string } | string => {
    const body = exact(req.body, "decision_id,milestone_id,tx_blob");
    if (!body) return "body must contain exactly {tx_blob, milestone_id, decision_id}";
    const { tx_blob, milestone_id, decision_id } = body as { tx_blob: unknown; milestone_id: unknown; decision_id: unknown };
    if (typeof tx_blob !== "string" || !BLOB_RE.test(tx_blob)) return "tx_blob must be a hex string";
    if (typeof milestone_id !== "string" || !ID_RE.test(milestone_id) || typeof decision_id !== "string" || !ID_RE.test(decision_id)) return "milestone_id / decision_id must match [A-Za-z0-9_.:-]{1,128}";
    try {
      return { tx: decode(tx_blob) as Record<string, unknown>, ms: milestone_id, decision_id };
    } catch (e) {
      return `tx_blob does not decode: ${(e as Error).message}`;
    }
  };

  app.post("/escrow/cosign", (req, reply) =>
    d.serial(async () => {
      const b = escrowBody(req);
      if (typeof b === "string") return bad(reply, b);
      const { tx, ms, decision_id } = b;
      const type = tx.TransactionType;
      if (type !== "EscrowCreate" && type !== "EscrowCancel") return bad(reply, "POST /escrow/cosign takes an EscrowCreate or EscrowCancel (EscrowFinish goes to /escrow/finish)");
      const memo = type === "EscrowCreate" ? parseEscrowMemo(tx).data : null;
      const rec = book.creates.get(ms);
      let f: EscrowFacts;
      try {
        f = await escrowFacts(tx, ms, type === "EscrowCreate" ? String(tx.Destination ?? "") : (rec?.destination ?? ""), type === "EscrowCreate" ? (memo?.ctr ?? null) : (rec?.ctr ?? null));
      } catch (e) {
        return unavailable(reply, e);
      }
      const r = type === "EscrowCreate" ? checkEscrowCreate(tx, ms, f) : checkEscrowCancel(tx, ms, f);
      if (r.refusal_reasons.length || r.checks.some((c) => !c.passed)) {
        d.logLine({ escrow: type, milestone_id: ms, decision_id, result: "refused", refusal_reasons: r.refusal_reasons });
        return reply.code(422).send({ ok: false, refusal_reasons: r.refusal_reasons, checks: r.checks });
      }
      let signed_blob: string;
      try {
        signed_blob = cosign(tx);
      } catch (e) {
        return bad(reply, `transaction failed validation: ${(e as Error).message}`);
      }
      try {
        book.append({
          type: type === "EscrowCreate" ? "create_signed" : "cancel_signed", at: new Date().toISOString(), milestone_id: ms, decision_id,
          sequence: tx.Sequence as number, last_ledger_sequence: tx.LastLedgerSequence as number,
          ...(type === "EscrowCreate"
            ? { destination: String(tx.Destination), amount: String((tx.Amount as { value?: string }).value), ctr: memo?.ctr, ein: memo?.ein, cancel_after: tx.CancelAfter as number }
            : { offer_sequence: tx.OfferSequence as number, destination: rec?.destination, ctr: rec?.ctr, ein: rec?.ein }),
        });
      } catch (e) {
        return reply.code(500).send({ ok: false, error: "record_write_failed", message: (e as Error).message });
      }
      d.logLine({ escrow: type, milestone_id: ms, decision_id, result: "signed", sequence: tx.Sequence });
      return reply.send({ ok: true, signer: "cosigner", signer_address: wallet.address, signed_blob, checks: r.checks, label: SIMULATED_ESCROW_LABEL });
    }),
  );

  app.post("/escrow/finish", (req, reply) =>
    d.serial(async () => {
      const b = escrowBody(req);
      if (typeof b === "string") return bad(reply, b);
      const { tx, ms, decision_id } = b;
      if (tx.TransactionType !== "EscrowFinish") return bad(reply, "POST /escrow/finish takes an unsigned EscrowFinish template");
      const rec = book.creates.get(ms);
      let f: EscrowFacts;
      try {
        const off = typeof tx.OfferSequence === "number" ? tx.OfferSequence : -1;
        const client = await d.xrplClient();
        const e = off >= 0 ? await readEscrow(client, policy.agentAccount, off, (await readLedgerView(client, policy.agentAccount)).validatedLedger) : null;
        f = await escrowFacts(tx, ms, e?.found ? e.destination : (rec?.destination ?? ""), rec?.ctr ?? null);
      } catch (e) {
        return unavailable(reply, e);
      }
      const r = checkEscrowFinish(tx, ms, f);
      if (r.refusal_reasons.length || r.checks.some((c) => !c.passed)) {
        d.logLine({ escrow: "EscrowFinish", milestone_id: ms, decision_id, result: "refused", refusal_reasons: r.refusal_reasons });
        return reply.code(422).send({ ok: false, refusal_reasons: r.refusal_reasons, checks: r.checks });
      }
      const cond = book.conditions.get(ms)!;
      const { fulfillment } = conditionFromPreimage(cond.preimage);
      let signed_blob: string;
      try {
        signed_blob = cosign({ ...tx, Condition: cond.condition, Fulfillment: fulfillment });
      } catch (e) {
        return bad(reply, `transaction failed validation: ${(e as Error).message}`);
      }
      try {
        // Single use: the officer's approval is consumed by this co-signature (recorded before the fulfillment leaves).
        book.append({ type: "finish_signed", at: new Date().toISOString(), milestone_id: ms, decision_id, sequence: tx.Sequence as number, last_ledger_sequence: tx.LastLedgerSequence as number, offer_sequence: tx.OfferSequence as number, release_approval_signature: f.releaseApproval?.approval?.signature });
      } catch (e) {
        return reply.code(500).send({ ok: false, error: "record_write_failed", message: (e as Error).message });
      }
      // Never log the fulfillment: it only leaves this process inside the co-signed EscrowFinish.
      d.logLine({ escrow: "EscrowFinish", milestone_id: ms, decision_id, result: "signed (fulfillment revealed inside the co-signed tx only)", sequence: tx.Sequence, offer_sequence: tx.OfferSequence });
      return reply.send({ ok: true, signer: "cosigner", signer_address: wallet.address, signed_blob, checks: r.checks, label: SIMULATED_ESCROW_LABEL });
    }),
  );

  return { governanceLog: govPath, escrowLog: escrowPath, escrowBook: book };
}
