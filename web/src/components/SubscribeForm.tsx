"use client";

import { useState } from "react";

export default function SubscribeForm({ siteId }: { siteId: string | null }) {
  const [phone, setPhone] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const res = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, site_id: siteId }),
    });
    setState(res.ok ? "done" : "error");
  }

  if (state === "done") {
    return <p className="text-sm text-green-700">Signed up. iMessage alerts via Photon (not connected yet).</p>;
  }

  return (
    <form onSubmit={submit} className="flex gap-2">
      <input
        type="tel"
        required
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="Phone number"
        className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
      />
      <button
        type="submit"
        disabled={state === "sending"}
        className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        Get iMessage alerts
      </button>
      {state === "error" && <span className="self-center text-xs text-red-600">Failed</span>}
    </form>
  );
}
