import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { nowNY } from "../lib/time";

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/health", async () => ({ ok: true, mode: ctx.store.mode, time: nowNY(), version: ctx.version }));
}
