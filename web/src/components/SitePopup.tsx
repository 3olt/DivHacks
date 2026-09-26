import type { Site } from "@/lib/types";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";
import { SITE_TYPE_LABELS, formatEventTime } from "@/lib/format";

// Small summary shown on the map when a pin is clicked. Full details open in the side panel.
export default function SitePopup({ site, onOpenDetails }: { site: Site; onOpenDetails: () => void }) {
  return (
    <div className="w-56 space-y-2 font-sans">
      <div>
        <p className="text-sm font-semibold text-gray-900">{site.name}</p>
        <p className="text-xs text-gray-500">{SITE_TYPE_LABELS[site.type]} · {site.address}</p>
      </div>
      {site.next_event && (
        <p className="text-xs text-gray-800">
          <span className="font-medium">{site.next_event.title}</span>
          <br />
          {formatEventTime(site.next_event.starts_at)}
        </p>
      )}
      <div className="flex items-center gap-1.5 text-xs">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: RISK_COLORS[site.risk.level] }} />
        <span className="font-medium text-gray-900">{RISK_LABELS[site.risk.level]}</span>
      </div>
      {site.risk.reasons[0] && <p className="text-xs text-gray-600">{site.risk.reasons[0]}</p>}
      {/* Placeholder: latest XRPL payment status from the agent goes here. */}
      <p className="rounded border border-dashed border-gray-300 px-2 py-1 text-[11px] text-gray-500">XRPL payment status coming soon</p>
      <button onClick={onOpenDetails} className="w-full rounded-md bg-gray-900 px-2 py-1.5 text-xs font-medium text-white">
        See money trail
      </button>
    </div>
  );
}
