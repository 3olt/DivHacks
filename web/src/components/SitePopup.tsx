import type { Site } from "@/lib/contracts";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";
import { SITE_TYPE_LABELS, formatEventTime } from "@/lib/format";

// Small summary shown on the map when a pin is clicked. Full details open in the side panel at the same time.
export default function SitePopup({ site }: { site: Site }) {
  const next = site.events[0] ?? null;
  return (
    <div className="w-56 space-y-2 font-sans">
      <div>
        <p className="text-sm font-semibold text-gray-900">{site.name}</p>
        <p className="text-xs text-gray-500">
          {SITE_TYPE_LABELS[site.type] ?? site.type} · {site.address ?? `${site.borough} ${site.zip}`}
        </p>
      </div>
      {next && (
        <p className="text-xs text-gray-800">
          <span className="font-medium">{next.title}</span>
          <br />
          {formatEventTime(next.starts_at)}
        </p>
      )}
      <div className="flex items-center gap-1.5 text-xs">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: RISK_COLORS[site.risk.level] }} />
        <span className="font-medium text-gray-900">{RISK_LABELS[site.risk.level]}</span>
      </div>
      <p className="text-xs text-gray-600">{site.risk.summary}</p>
    </div>
  );
}
