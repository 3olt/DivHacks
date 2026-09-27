import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "./http";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time comparison of a presented token with the expected one (both hashed, so lengths never leak). */
export function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string" || presented === "") return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Shared-secret header guard. When `expected` is unset/empty the route stays open (opt-in hardening).
 * Returns true when the request may proceed; otherwise it has already replied 401.
 */
export function requireToken(req: FastifyRequest, reply: FastifyReply, header: string, expected: string | undefined): boolean {
  if (!expected) return true;
  if (tokenMatches(req.headers[header], expected)) return true;
  void sendError(reply, 401, "unauthorized", `This endpoint needs the ${header} header (shared secret)`);
  return false;
}
