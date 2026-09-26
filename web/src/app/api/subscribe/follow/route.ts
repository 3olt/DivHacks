import { sendIMessage, toE164 } from "@/lib/imessage";
import { upsertApiSubscriber } from "@/lib/subscribers";

// Follow a map location: merges the site into the subscriber's site_ids on the API.
export async function POST(req: Request) {
  const { phone: rawPhone, site_id, site_name } = (await req.json()) as { phone?: string; site_id?: string; site_name?: string };
  const phone = toE164(rawPhone ?? "");
  if (!phone) return Response.json({ error: "Sign up first" }, { status: 400 });
  if (!site_id) return Response.json({ error: "Missing site" }, { status: 400 });

  const api = await upsertApiSubscriber({ phone, site_ids: [site_id] });
  if (!api.ok) return Response.json({ error: api.message }, { status: api.status });

  const imessage = await sendIMessage(
    phone,
    `You're following ${site_name ?? "this location"}. We'll text you about upcoming events and funding updates.`,
  );
  return Response.json({ site_id, imessage });
}
