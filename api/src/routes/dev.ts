import type { FastifyInstance } from "fastify";
import type { RiskLevel } from "../../../shared/contracts";
import type { AppContext } from "../context";
import { isRecord, queryString, sendError } from "../lib/http";
import { scrub } from "../lib/python";
import { nowNY } from "../lib/time";
import { devFlipRisk } from "../risk";

const LEVELS: RiskLevel[] = ["green", "yellow", "red"];

/** Dev helpers for building the UI. Not part of the product; do not call them from production UI. */
export function registerDevRoutes(app: FastifyInstance, ctx: AppContext): void {
  // POST /dev/flip/:site_id  body or query {level?: "green"|"yellow"|"red"}
  // Default: green if the site is not green, else yellow. Broadcasts site_updated.
  // Mongo mode: disabled (403 dev_route_disabled) unless DEV_ROUTES=1, because it overwrites a real site's score.
  app.post<{ Params: { site_id: string }; Querystring: Record<string, unknown> }>("/dev/flip/:site_id", async (req, reply) => {
    if (ctx.store.mode === "mongo" && !ctx.devRoutes) {
      return sendError(reply, 403, "dev_route_disabled", "POST /dev/flip is disabled in mongo mode (it would overwrite a real site's score). Start the API with DEV_ROUTES=1 to enable it; POST /dev/reset re-scores flipped sites.");
    }
    const site = await ctx.store.getSite(req.params.site_id);
    if (!site) return sendError(reply, 404, "site_not_found", `No site with id ${req.params.site_id}`);
    const fromBody = isRecord(req.body) ? req.body.level : undefined;
    const requested = fromBody ?? queryString(req.query?.level);
    if (requested !== undefined && !LEVELS.includes(requested as RiskLevel)) {
      return sendError(reply, 400, "invalid_level", `level must be one of: ${LEVELS.join(", ")}`);
    }
    const level: RiskLevel = (requested as RiskLevel | undefined) ?? (site.risk.level === "green" ? "yellow" : "green");
    const risk = devFlipRisk(level, nowNY());
    await ctx.store.setSiteRisk(site.id, risk);
    ctx.hub.broadcast({ type: "site_updated", site_id: site.id, risk });
    return { site_id: site.id, risk };
  });

  // POST /dev/reset
  // Fixture mode: restores sites, decisions and subscribers to the fixture state.
  // Mongo mode: runs data/demo_reset.py (the golden site back to its pre-demo level; Testnet history is kept), restores the
  // demo sites' fixture risk and re-scores dev-flipped sites. 409 run_in_progress while a real demo run is going.
  // Broadcasts site_updated for every site whose risk changed (mongo mode: always the golden), so open maps snap back.
  app.post("/dev/reset", async (_req, reply) => {
    const active = ctx.demoRunner?.blocking();
    if (active) {
      return sendError(reply, 409, "run_in_progress", `A demo run is still in progress (${active.scenario}, ${active.run_id}); reset after it finishes`, { run_id: active.run_id });
    }
    let changed: string[];
    try {
      changed = await ctx.store.reset();
    } catch (e) {
      reply.log.error(scrub((e as Error).message));
      return sendError(reply, 500, "reset_failed", scrub((e as Error).message).slice(0, 300));
    }
    for (const id of changed) {
      const site = await ctx.store.getSite(id);
      if (site) ctx.hub.broadcast({ type: "site_updated", site_id: site.id, risk: site.risk });
    }
    return ctx.store.mode === "mongo" ? { ok: true, site_updated: changed } : { ok: true };
  });
}
