import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { lookup, MONGO_SCENARIO_NAMES, NOOP_SCENARIOS, REAL_SCENARIOS, RunInProgressError } from "../demo/realRunner";
import { isScenario, SCENARIOS } from "../demo/scenarios";
import { sendError } from "../lib/http";

/** Scenarios that exist only on XRPL Testnet (mongo mode). In fixture mode they answer 409 testnet_only. */
const TESTNET_ONLY: Record<string, string> = {
  escrow: "escrow runs on XRPL Testnet only: start the API in mongo mode (API_MODE=mongo). The simulated escrow uses the city test token CTT, not RLUSD.",
  "escrow-release": "escrow runs on XRPL Testnet only: start the API in mongo mode (API_MODE=mongo). In mongo mode POST /demo/escrow runs the whole escrow, including the officer-approved release.",
  golden: "golden (the real Food Bank For NYC contract) runs on XRPL Testnet only: start the API in mongo mode (API_MODE=mongo)",
  uncredentialed: "uncredentialed runs on XRPL Testnet only: start the API in mongo mode (API_MODE=mongo)",
};

export function registerDemoRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Fixture mode: 202 {scenario, mode, decision, site_updated?}; broadcasts site_updated (if any) first, then decision.
  // Mongo mode: 202 {scenario, mode:"mongo", run_id, status:"started", decision:null} at once; the real Testnet run's
  // decisions arrive over WS /live as they happen (POST /events/payment from the agent), plus demo_run status messages.
  app.post<{ Params: { scenario: string } }>("/demo/:scenario", async (req, reply) => {
    const scenario = req.params.scenario;
    // Own-property lookups only: "constructor", "__proto__", "toString" ... are unknown scenarios (404), never map entries.
    const noop = lookup(NOOP_SCENARIOS, scenario);
    const testnetOnly = lookup(TESTNET_ONLY, scenario);

    if (ctx.demoRunner) {
      if (noop) {
        return reply.code(202).send({ scenario, mode: ctx.store.mode, run_id: null, status: "noop", decision: null, message: noop });
      }
      if (!lookup(REAL_SCENARIOS, scenario)) {
        return sendError(reply, 404, "unknown_scenario", `Unknown scenario "${scenario}"`, { scenarios: MONGO_SCENARIO_NAMES });
      }
      try {
        const run = ctx.demoRunner.start(scenario);
        return reply.code(202).send({ scenario, mode: ctx.store.mode, run_id: run.run_id, status: "started", cli_scenario: run.cli_scenario, decision: null });
      } catch (e) {
        if (e instanceof RunInProgressError) {
          return sendError(reply, 409, "run_in_progress", `A demo run is still in progress (${e.scenario}, ${e.runId}); wait for it to finish (GET /demo/runs/${e.runId})`, { run_id: e.runId });
        }
        throw e;
      }
    }

    if (testnetOnly) return sendError(reply, 409, "testnet_only", testnetOnly);
    if (!isScenario(scenario)) {
      return sendError(reply, 404, "unknown_scenario", `Unknown scenario "${scenario}"`, { scenarios: [...SCENARIOS] });
    }
    const result = await ctx.runScenario(scenario);
    if (result.site_updated) ctx.hub.broadcast({ type: "site_updated", site_id: result.site_updated.site_id, risk: result.site_updated.risk });
    ctx.hub.broadcast({ type: "decision", decision: result.decision });
    return reply.code(202).send(result);
  });

  // Mongo mode: status of a real demo run (running | succeeded | failed), its exit code, decision ids and log tail.
  app.get<{ Params: { run_id: string } }>("/demo/runs/:run_id", async (req, reply) => {
    const run = ctx.demoRunner?.get(req.params.run_id) ?? null;
    if (!run) return sendError(reply, 404, "run_not_found", `No demo run ${req.params.run_id}${ctx.demoRunner ? "" : " (fixture mode has no real runs)"}`);
    return run;
  });

  // Mongo mode: the recent runs, newest first (fixture mode: []).
  app.get("/demo/runs", async () => ctx.demoRunner?.list() ?? []);
}
