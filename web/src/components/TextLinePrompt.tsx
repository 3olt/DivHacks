import { IMESSAGE_LINE, IMESSAGE_LINE_DISPLAY } from "@/lib/photonLine";

// Photon free plan: the agent can only message people who have texted the line first.
export default function TextLinePrompt() {
  return (
    <div className="rounded-md bg-gray-50 p-3 text-sm text-gray-800">
      <p className="font-medium">Last step: turn on alerts</p>
      <p className="mt-1 text-xs text-gray-600">
        Text &quot;hi&quot; to{" "}
        <a href={`sms:${IMESSAGE_LINE}`} className="font-medium text-gray-900 underline">
          {IMESSAGE_LINE_DISPLAY}
        </a>{" "}
        from your phone. We can only message you after you&apos;ve texted us once.
      </p>
    </div>
  );
}
