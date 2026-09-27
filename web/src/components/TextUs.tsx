import { IMESSAGE_LINE, IMESSAGE_LINE_DISPLAY } from "@/lib/photonLine";

// Alerts are text-only (Photon iMessage + Grok). With a site, the message is "FOLLOW <site name>";
// without one, it's the subscriber's ZIP. On phones the link opens Messages with the text filled in.
export default function TextUs({ siteName }: { siteName?: string }) {
  const body = siteName ? `FOLLOW ${siteName}` : "";
  const href = `sms:${IMESSAGE_LINE}${body ? `?&body=${encodeURIComponent(body)}` : ""}`;
  return (
    <div className="rounded-md bg-gray-50 p-3 text-sm text-gray-800">
      {siteName ? (
        <p>
          Text <span className="font-semibold">FOLLOW {siteName}</span> to{" "}
          <a href={href} className="font-medium text-gray-900 underline">
            {IMESSAGE_LINE_DISPLAY}
          </a>{" "}
          to get a text when it gets paid and is financially stable again, and ask about it anytime.
        </p>
      ) : (
        <p>
          <span className="font-semibold">Get alerts by text:</span> text your ZIP code (for example 10453) to{" "}
          <a href={href} className="font-medium text-gray-900 underline">
            {IMESSAGE_LINE_DISPLAY}
          </a>
          . You&apos;ll get free food and events near you, and can ask questions anytime.
        </p>
      )}
    </div>
  );
}
