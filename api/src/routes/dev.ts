import type { FastifyInstance } from "fastify";
import type { RiskLevel } from "../../../shared/contracts";
import type { AppContext } from "../context";
import { isRecord, queryString, sendError } from "../lib/http";
import { nowNY } from "../lib/time";
import { devFlipRisk } from "../risk";

const LEVELS: RiskLevel[] = ["green", "yellow", "red"];

/** Dev helpers for building the UI. Not part of the product; do not call them from production UI. */
export function registerDevRoutes(app: FastifyInstance, ctx: AppContext): void {
  // POST /dev/flip/:site_id  body or query {level?: "green"|"yellow"|"red"}
  // Default: green if the site is not green, else yellow. Broadcasts site_updated.
  app.post<{ Params: { site_id: string }; Querystring: Record<string, unknown> }>("/dev/flip/:site_id", async (req, reply) => {
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

  // POST /dev/reset  restores sites, decisions and subscribers to the fixture state.
  // Also broadcasts site_updated for every site whose risk changed, so open maps snap back.
  app.post("/dev/reset", async () => {
    const changed = await ctx.store.reset();
    for (const id of changed) {
      const site = await ctx.store.getSite(id);
      if (site) ctx.hub.broadcast({ type: "site_updated", site_id: site.id, risk: site.risk });
    }
    return { ok: true };
  });
}
