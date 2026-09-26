import { sendIMessage, toE164 } from "@/lib/imessage";
import { getProfile, saveProfile } from "@/lib/store";
import { upsertApiSubscriber } from "@/lib/subscribers";
import type { SiteType } from "@/lib/contracts";
import type { SubscriberProfile } from "@/lib/types";

const INTERESTS: SiteType[] = ["food_pantry", "grocery_giveaway", "shelter", "youth_program", "event"];

const toInt = (v: unknown): number | null => {
  const n = Number(v);
  return v === "" || v == null || !Number.isInteger(n) || n < 0 ? null : n;
};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// Sign-up for event alerts: records the opt-in on the API, keeps the eligibility profile here,
// and sends a welcome iMessage via the Photon service.
export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, unknown>;
  const phone = toE164(str(body.phone));
  if (!phone) return Response.json({ error: "Enter a valid US phone number" }, { status: 400 });
  const zip = str(body.zip);
  if (!/^\d{5}$/.test(zip)) return Response.json({ error: "Enter a 5-digit ZIP code" }, { status: 400 });
  if (body.consent_sms !== true) return Response.json({ error: "Consent to receive iMessages is required" }, { status: 400 });
  const interests = Array.isArray(body.interests) ? INTERESTS.filter((i) => (body.interests as unknown[]).includes(i)) : [];

  const api = await upsertApiSubscriber({ phone, zip, interests });
  if (!api.ok) return Response.json({ error: api.message }, { status: api.status });

  const existing = getProfile(phone);
  const profile: SubscriberProfile = {
    phone,
    first_name: str(body.first_name),
    age: toInt(body.age),
    street_address: str(body.street_address),
    zip,
    borough: str(body.borough),
    household_size: toInt(body.household_size),
    language: str(body.language) || "English",
    interests,
    consent_sms: true,
    created_at: existing?.created_at ?? new Date().toISOString(),
  };
  saveProfile(profile);

  const name = profile.first_name ? `, ${profile.first_name}` : "";
  const imessage = await sendIMessage(
    phone,
    `Hi${name}! You're signed up for NYC community resource alerts. We'll text you about free food and events near you, and when their funding is running late.`,
  );
  return Response.json({ phone, imessage }, { status: existing ? 200 : 201 });
}
