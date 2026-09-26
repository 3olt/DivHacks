import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { queryString, sendError } from "../lib/http";

export const DEFAULT_DECISION_LIMIT = 50;
export const MAX_DECISION_LIMIT = 200;

export function registerDecisionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: Record<string, unknown> }>("/decisions", async (req, reply) => {
    const raw = queryString(req.query?.limit);
    let limit = DEFAULT_DECISION_LIMIT;
    if (raw !== undefined) {
      if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1 || Number(raw) > MAX_DECISION_LIMIT) {
        return sendError(reply, 400, "invalid_limit", `limit must be an integer from 1 to ${MAX_DECISION_LIMIT}`);
      }
      limit = Number(raw);
    }
    return ctx.store.listDecisions(limit);
  });
}
