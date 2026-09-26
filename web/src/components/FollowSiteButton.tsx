"use client";

import { useState } from "react";
import type { IMessageStatus } from "@/lib/imessage";
import { useSavedPhone } from "@/lib/savedPhone";
import IMessageNotice from "./IMessageNotice";
import TextLinePrompt from "./TextLinePrompt";

export default function FollowSiteButton({ siteId, siteName, onNeedSignup }: { siteId: string; siteName: string; onNeedSignup: () => void }) {
  const phone = useSavedPhone();
  const [status, setStatus] = useState<IMessageStatus | null>(null);
  const [error, setError] = useState("");

  if (!phone) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-gray-600">Sign up once with your phone number to follow locations.</p>
        <button onClick={onNeedSignup} className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white">
          Sign up for iMessage alerts
        </button>
      </div>
    );
  }

  if (status) {
    return (
      <div className="space-y-2">
        <IMessageNotice status={status} />
        {status === "not_allowed" && <TextLinePrompt />}
      </div>
    );
  }

  async function follow() {
    const res = await fetch("/api/subscribe/follow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, site_id: siteId, site_name: siteName }),
    });
    const data = await res.json();
    if (res.ok) setStatus(data.imessage);
    else setError(data.error ?? "Failed");
  }

  return (
    <div className="space-y-2">
      <button onClick={follow} className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white">
        Follow this location
      </button>
      {error && (
        <p className="text-xs text-red-600">
          {error}.{" "}
          {error === "Sign up first" && (
            <button onClick={onNeedSignup} className="underline">
              Sign up
            </button>
          )}
        </p>
      )}
    </div>
  );
}
