import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { nowNY } from "../lib/time";

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/health", async () => {
    const base = { ok: true, mode: ctx.store.mode, time: nowNY(), version: ctx.version };
    if (!ctx.demoRunner) return base;
    // Mongo mode (additive): the real demo run in progress, if any.
    const r = ctx.demoRunner.active;
    return { ...base, demo_run: r ? { run_id: r.run_id, scenario: r.scenario, status: r.status } : null };
  });
}
