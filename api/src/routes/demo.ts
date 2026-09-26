import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { isScenario, SCENARIOS } from "../demo/scenarios";
// PLACEHOLDER — simulated escrow. Remove with api/src/demo/escrowPlaceholder.ts.
import { isEscrowPlaceholderScenario, runEscrowPlaceholder } from "../demo/escrowPlaceholder";
import { sendError } from "../lib/http";

export function registerDemoRoutes(app: FastifyInstance, ctx: AppContext): void {
  // 202 {scenario, mode, decision, site_updated?}. Broadcasts site_updated (if any) first, then decision.
  app.post<{ Params: { scenario: string } }>("/demo/:scenario", async (req, reply) => {
    const scenario = req.params.scenario;
    // ---- PLACEHOLDER — simulated escrow (POST /demo/escrow, /demo/escrow-release). REMOVE this block
    // with api/src/demo/escrowPlaceholder.ts once xrpl/ does real escrow.
    if (isEscrowPlaceholderScenario(scenario)) {
      const result = await runEscrowPlaceholder(ctx.store, scenario);
      if (result.site_updated) ctx.hub.broadcast({ type: "site_updated", site_id: result.site_updated.site_id, risk: result.site_updated.risk });
      ctx.hub.broadcast({ type: "decision", decision: result.decision });
      return reply.code(202).send(result);
    }
    // ---- end PLACEHOLDER
    if (!isScenario(scenario)) {
      return sendError(reply, 404, "unknown_scenario", `Unknown scenario "${scenario}"`, { scenarios: [...SCENARIOS] });
    }
    const result = await ctx.runScenario(scenario);
    if (result.site_updated) ctx.hub.broadcast({ type: "site_updated", site_id: result.site_updated.site_id, risk: result.site_updated.risk });
    ctx.hub.broadcast({ type: "decision", decision: result.decision });
    return reply.code(202).send(result);
  });
}
