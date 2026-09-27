"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { fetchSites, fetchTrail } from "@/lib/api";
import type { Site, SiteType, Trail } from "@/lib/contracts";
import { connectLive } from "@/lib/live";
import { SITE_TYPE_LABELS } from "@/lib/format";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";
import MoneyFlow from "./MoneyFlow";
import SitePanel from "./SitePanel";
import TextUs from "./TextUs";

const MapView = dynamic(() => import("./MapView"), { ssr: false });

export default function Dashboard({ initialSiteId = null }: { initialSiteId?: string | null }) {
  const [sites, setSites] = useState<Site[]>([]);
  const [apiError, setApiError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialSiteId);
  const [trail, setTrail] = useState<Trail | null>(null);
  const [trailErrorFor, setTrailErrorFor] = useState<string | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  // Money trail per real site, for the Money flow list.
  const [trails, setTrails] = useState<Record<string, Trail>>({});
  const [hiddenTypes, setHiddenTypes] = useState<Set<SiteType>>(new Set());

  // Read inside WS callbacks without reconnecting when the selection changes.
  const selectedRef = useRef<string | null>(null);
  const sitesRef = useRef<Site[]>([]);
  useEffect(() => {
    selectedRef.current = selectedId;
    sitesRef.current = sites;
  }, [selectedId, sites]);

  // Live updates from the API: pins recolor on site_updated; the open trail refetches on relevant events.
  useEffect(() => {
    let cancelled = false;
    async function loadSites() {
      try {
        // The main map is real data only; the fictional demo sites live on /demo.
        const data = (await fetchSites()).filter((s) => !s.is_demo_data);
        if (!cancelled) {
          setSites(data);
          setApiError(false);
        }
        const loaded = await Promise.all(data.map((s) => fetchTrail(s.id).then((t) => [s.id, t] as const).catch(() => null)));
        if (!cancelled) setTrails(Object.fromEntries(loaded.filter((x) => x !== null)));
      } catch {
        if (!cancelled) setApiError(true);
      }
    }
    async function reloadTrail(id: string) {
      try {
        const t = await fetchTrail(id);
        if (cancelled) return;
        setTrails((m) => (id in m ? { ...m, [id]: t } : m));
        if (selectedRef.current === id) setTrail(t);
      } catch {
        // keep the last trail on a transient error
      }
    }
    loadSites();
    const stop = connectLive((msg) => {
      const open = selectedRef.current;
      if (msg.type === "hello") {
        loadSites();
        if (open) reloadTrail(open);
      } else if (msg.type === "site_updated") {
        setSites((s) => s.map((x) => (x.id === msg.site_id ? { ...x, risk: msg.risk } : x)));
        reloadTrail(msg.site_id);
      } else if (msg.type === "decision") {
        // A payment to one of these real organizations changes its money flow row.
        const site = sitesRef.current.find((x) => x.contract_ids.includes(msg.decision.contract_id) || x.nonprofit_ein === msg.decision.payee_ein);
        if (site) reloadTrail(site.id);
      }
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  // Fetch the money trail when a site is opened.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetchTrail(selectedId)
      .then((t) => {
        if (!cancelled) {
          setTrail(t);
          setTrailErrorFor(null);
        }
      })
      .catch(() => {
        if (!cancelled) setTrailErrorFor(selectedId);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  function closePanel() {
    setSelectedId(null);
    setTrail(null);
  }

  // Opening a site from the ledger: make sure its type isn't filtered out, so its pin and popup exist.
  function openSite(id: string) {
    const type = sites.find((s) => s.id === id)?.type;
    if (type && hiddenTypes.has(type)) {
      setHiddenTypes((prev) => {
        const next = new Set(prev);
        next.delete(type);
        return next;
      });
    }
    setSelectedId(id);
  }

  function toggleType(type: SiteType) {
    // Hiding the open site's type would leave its panel without a pin, so close it.
    if (!hiddenTypes.has(type) && sites.find((s) => s.id === selectedId)?.type === type) closePanel();
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  const selectedSite = sites.find((s) => s.id === selectedId) ?? null;
  const visibleSites = sites.filter((s) => !hiddenTypes.has(s.type));
  const counts = visibleSites.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.risk.level]: (acc[s.risk.level] ?? 0) + 1 }), {});
  const typeCounts = sites.reduce<Partial<Record<SiteType, number>>>((acc, s) => ({ ...acc, [s.type]: (acc[s.type] ?? 0) + 1 }), {});

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <div className="relative h-[55dvh] md:h-full md:flex-1">
        <MapView sites={visibleSites} selectedId={selectedId} onSelect={setSelectedId} onPopupChange={setPopupOpen} onDismiss={closePanel} />
        {/* Hidden (and click-through) while a pin popup is open so it doesn't cover it. */}
        <div className={`absolute left-3 top-3 z-[1000] max-w-xs rounded-lg bg-white/95 p-4 shadow-md transition-opacity ${popupOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}>
          <h1 className="text-base font-semibold text-gray-900">NYC community resources</h1>
          <p className="mt-1 hidden text-xs text-gray-600 md:block">Colored by the financial health of the city funding behind each one.</p>
          <ul className="mt-3 space-y-1">
            {(["green", "yellow", "red"] as const).map((lvl) => (
              <li key={lvl} className="flex items-center gap-2 text-xs text-gray-800">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: RISK_COLORS[lvl] }} />
                {RISK_LABELS[lvl]}
                <span className="ml-auto text-gray-500">{counts[lvl] ?? 0}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-1" role="group" aria-label="Filter by type">
            {(Object.keys(SITE_TYPE_LABELS) as SiteType[])
              .filter((t) => typeCounts[t])
              .map((t) => {
                const on = !hiddenTypes.has(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggleType(t)}
                    aria-pressed={on}
                    className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${on ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 bg-white text-gray-500 hover:border-gray-500"}`}
                  >
                    {SITE_TYPE_LABELS[t]} {typeCounts[t]}
                  </button>
                );
              })}
          </div>
          <p className="mt-3 text-[11px] text-gray-500">Real nonprofits from public records. Events are demo.</p>
          {apiError && <p className="mt-3 text-[11px] text-red-600">Can&apos;t reach the API. Is it running on :4000?</p>}
        </div>
      </div>

      <aside className="min-h-0 flex-1 overflow-y-auto border-t border-gray-200 bg-white md:w-[400px] md:flex-none md:border-l md:border-t-0">
        {selectedSite ? (
          <SitePanel
            key={selectedSite.id}
            site={selectedSite}
            trail={trail?.site_id === selectedSite.id ? trail : null}
            trailError={trailErrorFor === selectedSite.id}
            onClose={closePanel}
          />
        ) : (
          <div className="space-y-4 p-5">
            <TextUs />
            <MoneyFlow sites={sites} trails={trails} onOpenSite={openSite} />
          </div>
        )}
      </aside>
    </div>
  );
}
