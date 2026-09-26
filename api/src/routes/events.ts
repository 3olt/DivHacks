import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { isRecord, sendError } from "../lib/http";
import { asDecision, decisionShapeError } from "../lib/validateDecision";

/**
 * POST /events/payment {decision_id, decision?}
 * Called by the xrpl service after every decision (Phase 5). Optional `decision` = the full Decision
 * record, upserted by decision_id before processing. Released -> recompute the site's risk and broadcast
 * site_updated then decision; anything else -> broadcast decision only.
 */
export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/events/payment", async (req, reply) => {
    const body = isRecord(req.body) ? req.body : {};
    const pushed = body.decision;
    if (pushed !== undefined) {
      const err = decisionShapeError(pushed);
      if (err) return sendError(reply, 400, "invalid_decision", err);
    }
    const pushedDecision = pushed !== undefined ? asDecision(pushed) : undefined;
    const rawId = body.decision_id ?? pushedDecision?.decision_id;
    if (typeof rawId !== "string" || rawId.trim() === "") {
      return sendError(reply, 400, "missing_decision_id", "Send {decision_id} (and optionally the full {decision})");
    }
    if (pushedDecision && pushedDecision.decision_id !== rawId) {
      return sendError(reply, 400, "decision_id_mismatch", "decision_id does not match decision.decision_id");
    }
    if (pushedDecision) await ctx.store.upsertDecision(pushedDecision);

    const decision = await ctx.store.getDecision(rawId);
    if (!decision) return sendError(reply, 404, "decision_not_found", `No decision with id ${rawId}`);

    const site = await ctx.store.findSiteForDecision(decision);
    if (!site) {
      ctx.hub.broadcast({ type: "decision", decision });
      return { site_id: null, risk: null, broadcast: ["decision"] };
    }
    if (decision.outcome === "released") {
      const risk = (await ctx.store.applyRelease(site.id, decision))!;
      ctx.hub.broadcast({ type: "site_updated", site_id: site.id, risk });
      ctx.hub.broadcast({ type: "decision", decision });
      return { site_id: site.id, risk, broadcast: ["site_updated", "decision"] };
    }
    ctx.hub.broadcast({ type: "decision", decision });
    return { site_id: site.id, risk: site.risk, broadcast: ["decision"] };
  });
}
