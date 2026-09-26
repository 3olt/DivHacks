import type { FastifyReply } from "fastify";

/** Every error response has this shape: { error: "<machine_code>", message: "<human text>", ...extra }. */
export function sendError(reply: FastifyReply, status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  return reply.code(status).send({ error, message, ...extra });
}

/** Query-string values can arrive as a string or (when repeated) an array. Join repeats with commas. */
export function queryString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String).join(",");
  return String(v);
}

/** Strict number parse: rejects "", "abc", "1e", "Infinity". */
export function parseNumber(s: string): number | null {
  const t = s.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
