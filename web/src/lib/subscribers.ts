// Server-side helper: records the opt-in on the backend API (POST /subscribers, docs/API.md).
import { API_URL } from "./api";
import type { Subscriber } from "./contracts";

export async function upsertApiSubscriber(body: {
  phone: string;
  zip?: string;
  interests?: string[];
  site_ids?: string[];
}): Promise<{ ok: true; subscriber: Subscriber } | { ok: false; status: number; message: string }> {
  try {
    const res = await fetch(`${API_URL}/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, channel: "web" }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, status: res.status, message: data.message ?? "Sign-up failed" };
    return { ok: true, subscriber: data as Subscriber };
  } catch {
    return { ok: false, status: 502, message: "The API isn't reachable" };
  }
}
