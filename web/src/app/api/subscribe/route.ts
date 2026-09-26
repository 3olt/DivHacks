import { sendIMessage, toE164 } from "@/lib/imessage";
import { getSubscriber, upsertSubscriber } from "@/lib/store";
import type { AlertInterest, Subscriber } from "@/lib/types";

const INTERESTS: AlertInterest[] = ["food", "youth", "seniors", "events"];

const toInt = (v: unknown): number | null => {
  const n = Number(v);
  return v === "" || v == null || !Number.isInteger(n) || n < 0 ? null : n;
};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// Sign-up: save the intake profile and send a welcome iMessage via Photon.
export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, unknown>;
  const phone = toE164(str(body.phone));
  if (!phone) return Response.json({ error: "Enter a valid US phone number" }, { status: 400 });
  if (body.consent_sms !== true) return Response.json({ error: "Consent to receive iMessages is required" }, { status: 400 });

  const existing = getSubscriber(phone);
  const subscriber: Subscriber = {
    phone,
    first_name: str(body.first_name),
    age: toInt(body.age),
    street_address: str(body.street_address),
    zip: str(body.zip),
    borough: str(body.borough),
    household_size: toInt(body.household_size),
    language: str(body.language) || "English",
    interests: Array.isArray(body.interests) ? INTERESTS.filter((i) => (body.interests as unknown[]).includes(i)) : [],
    site_ids: existing?.site_ids ?? [],
    consent_sms: true,
    created_at: existing?.created_at ?? new Date().toISOString(),
  };
  upsertSubscriber(subscriber);

  const name = subscriber.first_name ? `, ${subscriber.first_name}` : "";
  const imessage = await sendIMessage(
    phone,
    `Hi${name}! You're signed up for NYC community resource alerts. We'll text you about free food and events near you, and when their funding is running late.`,
  );
  return Response.json({ phone, imessage }, { status: existing ? 200 : 201 });
}
