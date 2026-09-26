import type { FastifyInstance } from "fastify";
import type { SiteType } from "../../../shared/contracts";
import type { AppContext } from "../context";
import { parseNumber, queryString, sendError } from "../lib/http";
import type { SiteQuery } from "../store";

export const SITE_TYPES: SiteType[] = ["food_pantry", "grocery_giveaway", "shelter", "youth_program", "event"];
export const DEFAULT_RADIUS_M = 2000;
export const MAX_RADIUS_M = 50_000;

type ParseResult = { ok: true; query: SiteQuery } | { ok: false; error: string; message: string };

const validLng = (n: number) => n >= -180 && n <= 180;
const validLat = (n: number) => n >= -90 && n <= 90;

function parseNumbers(raw: string, count: number): number[] | null {
  const parts = raw.split(",");
  if (parts.length !== count) return null;
  const nums = parts.map(parseNumber);
  return nums.every((n): n is number => n !== null) ? nums : null;
}

/** Parse and validate GET /sites query params. Filters combine with AND. */
export function parseSiteQuery(q: Record<string, unknown>): ParseResult {
  const query: SiteQuery = {};

  const type = queryString(q.type);
  if (type !== undefined && type.trim() !== "") {
    const types = type.split(",").map((t) => t.trim()).filter(Boolean);
    const bad = types.filter((t) => !(SITE_TYPES as string[]).includes(t));
    if (bad.length) return { ok: false, error: "invalid_type", message: `Unknown type(s): ${bad.join(", ")}. Allowed: ${SITE_TYPES.join(", ")}` };
    query.types = types as SiteType[];
  }

  const bbox = queryString(q.bbox);
  if (bbox !== undefined) {
    const n = parseNumbers(bbox, 4);
    if (!n) return { ok: false, error: "invalid_bbox", message: 'bbox must be "minLng,minLat,maxLng,maxLat" (4 numbers)' };
    const [minLng, minLat, maxLng, maxLat] = n;
    if (!validLng(minLng) || !validLng(maxLng) || !validLat(minLat) || !validLat(maxLat)) {
      return { ok: false, error: "invalid_bbox", message: "bbox longitudes must be in [-180, 180] and latitudes in [-90, 90]" };
    }
    if (minLng > maxLng || minLat > maxLat) {
      return { ok: false, error: "invalid_bbox", message: "bbox min values must be <= max values (order: minLng,minLat,maxLng,maxLat)" };
    }
    query.bbox = [minLng, minLat, maxLng, maxLat];
  }

  let radius = DEFAULT_RADIUS_M;
  const radiusRaw = queryString(q.radius_m);
  if (radiusRaw !== undefined) {
    const r = parseNumber(radiusRaw);
    if (r === null || r <= 0 || r > MAX_RADIUS_M) {
      return { ok: false, error: "invalid_radius", message: `radius_m must be a number > 0 and <= ${MAX_RADIUS_M}` };
    }
    radius = r;
  }

  const near = queryString(q.near);
  if (near !== undefined) {
    const n = parseNumbers(near, 2);
    if (!n || !validLng(n[0]) || !validLat(n[1])) {
      return { ok: false, error: "invalid_near", message: 'near must be "lng,lat" (GeoJSON order), e.g. near=-73.9095,40.8538' };
    }
    query.near = { lng: n[0], lat: n[1], radius_m: radius };
  }

  return { ok: true, query };
}

export function registerSiteRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: Record<string, unknown> }>("/sites", async (req, reply) => {
    const parsed = parseSiteQuery(req.query ?? {});
    if (!parsed.ok) return sendError(reply, 400, parsed.error, parsed.message);
    return ctx.store.listSites(parsed.query);
  });

  app.get<{ Params: { id: string } }>("/sites/:id", async (req, reply) => {
    const site = await ctx.store.getSite(req.params.id);
    if (!site) return sendError(reply, 404, "site_not_found", `No site with id ${req.params.id}`);
    return site;
  });

  app.get<{ Params: { id: string } }>("/sites/:id/trail", async (req, reply) => {
    const trail = await ctx.store.getTrail(req.params.id);
    if (!trail) return sendError(reply, 404, "site_not_found", `No site with id ${req.params.id}`);
    return trail;
  });
}
