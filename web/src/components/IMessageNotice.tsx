import type { IMessageStatus } from "@/lib/imessage";

const MESSAGES: Record<IMessageStatus, { text: string; className: string }> = {
  live: { text: "Sent. Check your iMessages.", className: "text-green-700" },
  "dry-run": { text: "Saved. The iMessage service is in dry-run mode (no Photon keys yet), so no text was sent.", className: "text-yellow-700" },
  not_allowed: { text: "Saved, but we can't text this number yet. Text the line below first; on the free plan the number must also be on the Photon Users list.", className: "text-yellow-700" },
  offline: { text: "Saved, but the iMessage service isn't running, so no text was sent.", className: "text-yellow-700" },
};

export default function IMessageNotice({ status }: { status: IMessageStatus }) {
  const m = MESSAGES[status];
  return <p className={`text-xs ${m.className}`}>{m.text}</p>;
}
