import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import type { SinceQuery } from "../decisionSummary";
import { queryString, sendError } from "../lib/http";
import { toMillis } from "../lib/time";

export const DEFAULT_DECISION_LIMIT = 50;
/** Raised from 200 to 1000 on Sun 06:15 (the default is unchanged). */
export const MAX_DECISION_LIMIT = 1000;

/** ?since= for GET /decisions/summary: "epoch" (default) | "all" | an ISO date (YYYY-MM-DD = 00:00 UTC) or date-time with
 *  Z or an offset. A "+" offset that arrived unencoded (decoded as a space) is accepted too. Returns null if invalid. */
export function parseSince(raw: string | undefined): SinceQuery | null {
  const s = (raw ?? "").trim();
  if (s === "" || s.toLowerCase() === "epoch") return { kind: "epoch" };
  if (s.toLowerCase() === "all") return { kind: "all" };
  const iso = s.replace(/ (\d{2}:?\d{2})$/, "+$1");
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2}))?$/i.test(iso)) return null;
  const ms = toMillis(iso);
  return Number.isFinite(ms) ? { kind: "iso", ms } : null;
}

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

  // Per-site paid / stopped / pending / held totals over EVERY decision since the bound (no cap), for "Effect on the
  // locations". Default since=epoch = the last demo reset (POST /dev/reset).
  app.get<{ Querystring: Record<string, unknown> }>("/decisions/summary", async (req, reply) => {
    const q = parseSince(queryString(req.query?.since));
    if (!q) {
      return sendError(reply, 400, "invalid_since", 'since must be "epoch" (default: since the last demo reset), "all", or an ISO 8601 date / date-time with Z or an offset (e.g. 2026-09-27T10:00:00Z; encode "+" as %2B)');
    }
    return ctx.store.decisionSummary(q);
  });
}
