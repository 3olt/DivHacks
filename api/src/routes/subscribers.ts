import type { FastifyInstance } from "fastify";
import type { Subscriber } from "../../../shared/contracts";
import type { AppContext } from "../context";
import { isRecord, queryString, sendError } from "../lib/http";
import { normalizeUsPhone } from "../lib/phone";
import { SITE_TYPES } from "./sites";

const CHANNELS: Subscriber["channel"][] = ["web", "imessage"];
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "");

export function registerSubscriberRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Upsert by phone: 201 on create, 200 on update. On update, zip/channel are replaced only when sent;
  // interests and site_ids are merged.
  app.post("/subscribers", async (req, reply) => {
    const body = req.body;
    if (!isRecord(body)) return sendError(reply, 400, "invalid_body", "Send a JSON object: {phone, zip, interests?, site_ids?, channel?}");

    const phone = normalizeUsPhone(body.phone);
    if (!phone) return sendError(reply, 400, "invalid_phone", "phone must be a US number, e.g. (212) 555-0142, 2125550142 or +12125550142");

    if (body.site_ids !== undefined && !isStringArray(body.site_ids)) {
      return sendError(reply, 400, "invalid_site_ids", "site_ids must be an array of site id strings");
    }
    if (body.site_id !== undefined && body.site_id !== null && typeof body.site_id !== "string") {
      return sendError(reply, 400, "invalid_site_ids", "site_id must be a string");
    }
    // Convenience: a single `site_id` (what web/src/components/SubscribeForm.tsx sends today) is merged in.
    const siteIds = [...new Set([...((body.site_ids as string[] | undefined) ?? []), ...(typeof body.site_id === "string" && body.site_id ? [body.site_id] : [])])];
    const unknown = await ctx.store.missingSiteIds(siteIds);
    if (unknown.length) return sendError(reply, 400, "unknown_site_ids", `Unknown site id(s): ${unknown.join(", ")}`, { unknown_site_ids: unknown });

    let zip: string | undefined = typeof body.zip === "string" || typeof body.zip === "number" ? String(body.zip).trim() : undefined;
    if (zip === undefined || zip === "") {
      // No zip sent: an existing subscriber keeps their stored zip (subscribing to a site in another
      // neighborhood must not move their home zip); a new subscriber defaults to the first site's zip.
      const existing = await ctx.store.getSubscriber(phone);
      zip = existing?.zip ?? (siteIds.length ? (await ctx.store.getSite(siteIds[0]))?.zip : undefined);
    }
    if (!zip || !/^\d{5}$/.test(zip)) return sendError(reply, 400, "invalid_zip", "zip must be exactly 5 digits, e.g. 10453");

    if (body.interests !== undefined && (!isStringArray(body.interests) || !body.interests.every((i) => (SITE_TYPES as string[]).includes(i)))) {
      return sendError(reply, 400, "invalid_interests", `interests must be an array of: ${SITE_TYPES.join(", ")}`);
    }
    if (body.channel !== undefined && !CHANNELS.includes(body.channel as Subscriber["channel"])) {
      return sendError(reply, 400, "invalid_channel", `channel must be one of: ${CHANNELS.join(", ")}`);
    }

    const { subscriber, created } = await ctx.store.upsertSubscriber({
      phone,
      zip,
      interests: body.interests as string[] | undefined,
      site_ids: siteIds,
      channel: body.channel as Subscriber["channel"] | undefined,
    });
    return reply.code(created ? 201 : 200).send(subscriber);
  });

  // Accepts URL-encoded E.164 (%2B12125550142), 10-digit (2125550142) or 11-digit (12125550142).
  app.delete<{ Params: { phone: string } }>("/subscribers/:phone", async (req, reply) => {
    const phone = normalizeUsPhone(req.params.phone);
    if (!phone) return sendError(reply, 400, "invalid_phone", "phone must be a US number in E.164 (+12125550142, URL-encoded as %2B12125550142) or 10 digits");
    const removed = await ctx.store.deleteSubscriber(phone);
    if (!removed) return sendError(reply, 404, "subscriber_not_found", `No subscriber with phone ${phone}`);
    return reply.code(204).send();
  });

  app.get<{ Querystring: Record<string, unknown> }>("/subscribers", async (req) => {
    const siteId = queryString(req.query?.site_id)?.trim();
    return ctx.store.listSubscribers(siteId || undefined);
  });
}
