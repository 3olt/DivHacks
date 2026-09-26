// Client for the iMessage service in /imessage (Photon Spectrum).
const IMESSAGE_SERVICE_URL = process.env.IMESSAGE_SERVICE_URL ?? "http://localhost:4003";

export type IMessageStatus = "live" | "dry-run" | "not_allowed" | "offline";

export function sendIMessage(phone: string, text: string): Promise<IMessageStatus> {
  return post("/notify", { phone, text });
}

// Welcome text with Grok's picks near the subscriber (built by the iMessage service from the API).
export function sendWelcome(phone: string, firstName: string): Promise<IMessageStatus> {
  return post("/welcome", { phone, first_name: firstName });
}

async function post(path: string, body: object): Promise<IMessageStatus> {
  try {
    const res = await fetch(`${IMESSAGE_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 403) return "not_allowed";
    if (!res.ok) return "offline";
    const data = (await res.json()) as { mode: "live" | "dry-run" };
    return data.mode;
  } catch {
    return "offline";
  }
}

// US numbers only for now: "(212) 555-1234" -> "+12125551234". Returns null if invalid.
export function toE164(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
