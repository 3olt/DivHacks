import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { requireToken } from "../lib/auth";
import { isRecord, sendError } from "../lib/http";
import { asDecision, decisionShapeError } from "../lib/validateDecision";

/**
 * POST /events/payment {decision_id, decision?}   (header x-events-token when EVENTS_TOKEN is set)
 * Called by the agent (xrpl/, NOTIFY_API=1) after every decision it records.
 * - Fixture mode: the optional full `decision` is upserted first (as before).
 * - Mongo mode: the agent's Mongo record is AUTHORITATIVE. A body `decision` is shape-checked and its decision_id must
 *   match, but it is otherwise ignored: the API reads the stored record and broadcasts only that.
 * Then: find the site (contract_ids contains decision.contract_id, else nonprofit_ein = payee_ein).
 *   released -> recompute the site's risk (mongo: real sites via data/risk.py; demo sites keep their fixture risk)
 *               and broadcast site_updated THEN decision; if the risk did not change, decision only.
 *   otherwise -> broadcast decision only.
 * Events are processed one at a time in arrival order, so the WS order matches the agent's order.
 * Mongo mode: a REPLAY (same decision_id, stored record unchanged since it was last broadcast) answers
 *   200 {site_id:null, risk:null, broadcast:[], note:"already broadcast"} and does nothing (no risk.py run, no WS message).
 *   A changed stored record (the agent re-recorded it) is broadcast again; a release whose risk recompute failed may retry.
 */
export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  let queue: Promise<unknown> = Promise.resolve();
  /** decision_id -> fingerprint of the stored record last broadcast (mongo mode). Bounded. */
  const broadcasted = new Map<string, string>();
  const remember = (id: string, fp: string) => {
    broadcasted.delete(id);
    broadcasted.set(id, fp);
    while (broadcasted.size > 5000) broadcasted.delete(broadcasted.keys().next().value!);
  };
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  app.post("/events/payment", async (req, reply) => {
    if (!requireToken(req, reply, "x-events-token", ctx.eventsToken)) return reply;
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
    const mongo = ctx.store.mode === "mongo";
    if (pushedDecision && !mongo) await ctx.store.upsertDecision(pushedDecision);

    return serial(async () => {
      const decision = await ctx.store.getDecision(rawId);
      if (!decision) return sendError(reply, 404, "decision_not_found", `No decision with id ${rawId}`);
      const fp = createHash("sha256").update(JSON.stringify(decision)).digest("hex");
      if (mongo && broadcasted.get(decision.decision_id) === fp) {
        return { site_id: null, risk: null, broadcast: [], note: "already broadcast: this stored decision was already sent over WS /live (replays are ignored)" };
      }
      ctx.demoRunner?.noteDecision(decision.decision_id);

      const site = await ctx.store.findSiteForDecision(decision);
      if (!site) {
        ctx.hub.broadcast({ type: "decision", decision });
        remember(decision.decision_id, fp);
        return { site_id: null, risk: null, broadcast: ["decision"] };
      }
      if (decision.outcome === "released") {
        const risk = await ctx.store.applyRelease(site.id, decision);
        if (risk) {
          ctx.hub.broadcast({ type: "site_updated", site_id: site.id, risk });
          ctx.hub.broadcast({ type: "decision", decision });
          remember(decision.decision_id, fp);
          return { site_id: site.id, risk, broadcast: ["site_updated", "decision"] };
        }
        ctx.hub.broadcast({ type: "decision", decision });
        // A demo site keeps its fixture risk (done); a failed recompute on a real site may be retried by a repeat event.
        if (site.is_demo_data) remember(decision.decision_id, fp);
        const note = site.is_demo_data ? "demo site: its fixture risk is kept (demo sites are not re-scored)" : "risk recompute failed: the previous risk is kept (see the API log)";
        return { site_id: site.id, risk: site.risk, broadcast: ["decision"], note };
      }
      ctx.hub.broadcast({ type: "decision", decision });
      remember(decision.decision_id, fp);
      return { site_id: site.id, risk: site.risk, broadcast: ["decision"] };
    });
  });
}
