import { sendIMessage, toE164 } from "@/lib/imessage";
import { getSiteDetail, getSubscriber, upsertSubscriber } from "@/lib/store";

// Follow a map location: requires an existing sign-up.
export async function POST(req: Request) {
  const { phone: rawPhone, site_id } = (await req.json()) as { phone?: string; site_id?: string };
  const phone = toE164(rawPhone ?? "");
  const subscriber = phone ? getSubscriber(phone) : undefined;
  if (!subscriber) return Response.json({ error: "Sign up first" }, { status: 404 });
  const detail = site_id ? getSiteDetail(site_id) : null;
  if (!detail) return Response.json({ error: "Site not found" }, { status: 404 });

  if (!subscriber.site_ids.includes(detail.site.id)) {
    upsertSubscriber({ ...subscriber, site_ids: [...subscriber.site_ids, detail.site.id] });
  }
  const imessage = await sendIMessage(
    subscriber.phone,
    `You're following ${detail.site.name}. We'll text you about upcoming events and funding updates.`,
  );
  return Response.json({ site_id: detail.site.id, imessage });
}
