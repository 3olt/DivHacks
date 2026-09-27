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
 *   released -> (Sun 04:50: risk vs demo_risk) the public `risk` is NEVER changed and site_updated is NEVER sent.
 *               The site's demo_risk is recomputed (mongo: the golden via data/risk.py --demo-risk, Option B demo scale;
 *               the 4 demo sites via the fixture release rule; other real sites: no demo effect; fixture mode: the
 *               fixture release rule), stored, and broadcast as demo_risk_updated THEN decision. No demo effect: decision only.
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
        // Sun 04:50: a Testnet payment NEVER changes the public risk and is NEVER sent as site_updated (iMessage and /map
        // listen to that). It only updates the /demo what-if score: demo_risk_updated, then decision.
        const res = await ctx.store.applyRelease(site.id, decision);
        if (res.update) {
          const u = res.update;
          ctx.hub.broadcast({ type: "demo_risk_updated", site_id: u.site_id, demo_risk: u.demo_risk, previous_demo_risk: u.previous_demo_risk });
          ctx.hub.broadcast({ type: "decision", decision });
          remember(decision.decision_id, fp);
          return { site_id: site.id, risk: site.risk, demo_risk: u.demo_risk, previous_demo_risk: u.previous_demo_risk, broadcast: ["demo_risk_updated", "decision"] };
        }
        ctx.hub.broadcast({ type: "decision", decision });
        // A failed golden demo_risk recompute may be retried by a repeat event; anything else is done.
        if (!res.retry) remember(decision.decision_id, fp);
        return { site_id: site.id, risk: site.risk, demo_risk: site.demo_risk ?? null, broadcast: ["decision"], note: res.note };
      }
      ctx.hub.broadcast({ type: "decision", decision });
      remember(decision.decision_id, fp);
      return { site_id: site.id, risk: site.risk, demo_risk: site.demo_risk ?? null, broadcast: ["decision"] };
    });
  });
}
