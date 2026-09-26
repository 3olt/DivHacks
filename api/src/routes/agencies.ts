import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { sendError } from "../lib/http";

export function registerAgencyRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Code is case-insensitive: /agencies/hra/stats == /agencies/HRA/stats
  app.get<{ Params: { code: string } }>("/agencies/:code/stats", async (req, reply) => {
    const stats = await ctx.store.getAgencyStats(req.params.code);
    if (!stats) return sendError(reply, 404, "agency_not_found", `No stats for agency ${req.params.code}. Known: HRA, DHS, DYCD`);
    return stats;
  });
}
