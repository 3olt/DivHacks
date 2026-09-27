// xrpl service routes added in Phase 3 by builder B (agent side; the service holds only AGENT_SEED, weight 1):
//   GET  /approvals                             -> {ok, approvals: PendingApproval[]}   (newest first)
//   POST /approvals/:decision_id/execute {approval_id}
//        Called by the OFFICER service after the human approved (POST :4004/approvals/:decision_id). Rebuilds the pending
//        payment fresh, signs as agent, gets the officer's signature (only for the exact approved tx) and the co-signer's,
//        submits the 3-signer payment and records a NEW Decision (audit.approved_from). 200 {ok, decision, explorer_url,
//        engine_result} | 404/409/410/422 {ok:false, error, message, decision?}
//   GET  /escrow/milestones                     -> {ok, label, milestones: EscrowMilestone[]}   (SIMULATED escrow, CTT test token)
//   POST /escrow/milestones {contract_id, amount, milestone_id?, cancel_after_hours?}
//        -> {ok, decision (held_escrow), milestone, explorer_url}   (CTT test token, NOT RLUSD)
//   POST /escrow/milestones/:milestone_id/release {report_text}
//        -> the report goes through the Grok verifier + builder; the co-signer reveals the fulfillment inside the finish ONLY
//        if the officer approved this milestone's release first (POST :4004/escrow/milestones/:id/approve-release, officer
//        credential required); otherwise refused escrow_release_not_approved -> {ok, decision (released|refused), explorer_url}
// Everything that signs runs on the service's serial queue (agent_account has one Sequence).
import type { FastifyInstance } from "fastify";
import type { EscrowMilestone } from "../../../shared/contracts";
import { executeApproved, listPendingApprovals } from "../agent/approvals";
import { createMilestoneEscrow, ensureAgentCttLine, releaseMilestoneEscrow, LABEL } from "../agent/escrow";
import { COLL } from "../lib/mongo";
import type { ServiceDeps } from "./routes";

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function registerAgentRoutes(app: FastifyInstance, d: ServiceDeps & { officerUrl: string }): void {
  app.get("/approvals", async () => ({ ok: true, approvals: await listPendingApprovals(d.db) }));

  app.post("/approvals/:decision_id/execute", (req, reply) =>
    d.serial(async () => {
      const { decision_id } = req.params as { decision_id: string };
      if (!ID_RE.test(decision_id)) return reply.code(400).send({ ok: false, error: "bad_request", message: "bad decision_id" });
      const approval_id = (req.body as { approval_id?: unknown } | null)?.approval_id;
      d.ctx.log(`approvals: the officer asks to execute approved decision ${decision_id} (approval ${String(approval_id)})`);
      const r = await executeApproved(decision_id, approval_id, d.ctx, d.officerUrl);
      return reply.code(r.status).send({ ok: r.ok, error: r.error ?? null, message: r.message, decision: r.decision ?? null, explorer_url: r.explorer_url ?? null, engine_result: r.engine_result ?? null });
    }),
  );

  app.get("/escrow/milestones", async () => ({
    ok: true,
    label: LABEL,
    milestones: await d.db.collection<EscrowMilestone>(COLL.escrowMilestones).find({}, { projection: { _id: 0 } }).sort({ cancel_after: -1 }).limit(50).toArray(),
  }));

  app.post("/escrow/milestones", (req, reply) =>
    d.serial(async () => {
      const b = (req.body ?? {}) as { contract_id?: unknown; amount?: unknown; milestone_id?: unknown; cancel_after_hours?: unknown };
      if (typeof b.contract_id !== "string" || !ID_RE.test(b.contract_id)) return reply.code(400).send({ ok: false, error: "bad_request", message: "contract_id is required" });
      if (typeof b.amount !== "string" || !/^\d{1,6}(\.\d{1,6})?$/.test(b.amount) || !(Number(b.amount) > 0)) return reply.code(400).send({ ok: false, error: "bad_request", message: "amount must be a positive decimal string" });
      const hours = b.cancel_after_hours === undefined ? 24 : Number(b.cancel_after_hours);
      if (!(hours >= 1.1 && hours <= 71)) return reply.code(400).send({ ok: false, error: "bad_request", message: "cancel_after_hours must be within 1.1..71" });
      try {
        await ensureAgentCttLine(d.ctx);
        const r = await createMilestoneEscrow(d.ctx, { contract_id: b.contract_id, amount: b.amount, milestone_id: typeof b.milestone_id === "string" ? b.milestone_id : undefined, cancel_after_hours: hours });
        return reply.send({ ok: r.decision.outcome === "held_escrow", label: LABEL, decision: r.decision, milestone: r.milestone, explorer_url: r.explorer_url });
      } catch (e) {
        return reply.code(503).send({ ok: false, error: "escrow_failed", message: (e as Error).message });
      }
    }),
  );

  app.post("/escrow/milestones/:milestone_id/release", (req, reply) =>
    d.serial(async () => {
      const { milestone_id } = req.params as { milestone_id: string };
      const text = (req.body as { report_text?: unknown } | null)?.report_text;
      if (!ID_RE.test(milestone_id)) return reply.code(400).send({ ok: false, error: "bad_request", message: "bad milestone_id" });
      if (typeof text !== "string" || !text.trim() || text.length > 20000) return reply.code(400).send({ ok: false, error: "bad_request", message: "report_text (1..20000 chars) is required" });
      try {
        const r = await releaseMilestoneEscrow(d.ctx, milestone_id, { kind: "text", text, name: `milestone-report-${milestone_id}.txt` });
        return reply.send({ ok: r.decision.outcome === "released", label: LABEL, decision: r.decision, explorer_url: r.explorer_url });
      } catch (e) {
        return reply.code(503).send({ ok: false, error: "escrow_failed", message: (e as Error).message });
      }
    }),
  );
}
