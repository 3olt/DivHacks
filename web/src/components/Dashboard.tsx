"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { fetchSites, fetchTrail } from "@/lib/api";
import type { Site, Trail } from "@/lib/contracts";
import { connectLive } from "@/lib/live";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";
import SitePanel from "./SitePanel";
import SignupForm from "./SignupForm";

const MapView = dynamic(() => import("./MapView"), { ssr: false });

export default function Dashboard() {
  const [sites, setSites] = useState<Site[]>([]);
  const [apiError, setApiError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trail, setTrail] = useState<Trail | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);

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
        const data = await fetchSites();
        if (!cancelled) {
          setSites(data);
          setApiError(false);
        }
      } catch {
        if (!cancelled) setApiError(true);
      }
    }
    async function reloadTrail(id: string) {
      try {
        const t = await fetchTrail(id);
        if (!cancelled && selectedRef.current === id) setTrail(t);
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
        if (open === msg.site_id) reloadTrail(open);
      } else if (msg.type === "decision") {
        const site = sitesRef.current.find((x) => x.id === open);
        if (open && site?.contract_ids.includes(msg.decision.contract_id)) reloadTrail(open);
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
        if (!cancelled) setTrail(t);
      })
      .catch(() => {
        if (!cancelled) setApiError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  function closePanel() {
    setSelectedId(null);
    setTrail(null);
  }

  const selectedSite = sites.find((s) => s.id === selectedId) ?? null;
  const counts = sites.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.risk.level]: (acc[s.risk.level] ?? 0) + 1 }), {});

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <div className="relative h-[55dvh] md:h-full md:flex-1">
        <MapView sites={sites} selectedId={selectedId} onSelect={setSelectedId} onPopupChange={setPopupOpen} />
        {/* Hidden while a pin popup is open so it doesn't cover it. */}
        <div className={`pointer-events-none absolute left-3 top-3 z-[1000] max-w-xs rounded-lg bg-white/95 p-4 shadow-md transition-opacity ${popupOpen ? "opacity-0" : "opacity-100"}`}>
          <h1 className="text-base font-semibold text-gray-900">NYC community resources</h1>
          <p className="mt-1 hidden text-xs text-gray-600 md:block">Colored by whether the city money behind each one is on time.</p>
          <ul className="mt-3 space-y-1">
            {(["green", "yellow", "red"] as const).map((lvl) => (
              <li key={lvl} className="flex items-center gap-2 text-xs text-gray-800">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: RISK_COLORS[lvl] }} />
                {RISK_LABELS[lvl]}
                <span className="ml-auto text-gray-500">{counts[lvl] ?? 0}</span>
              </li>
            ))}
          </ul>
          {sites.some((s) => s.is_demo_data) && <p className="mt-3 text-[11px] text-gray-500">Includes demo data.</p>}
          {apiError && <p className="mt-3 text-[11px] text-red-600">Can&apos;t reach the API. Is it running on :4000?</p>}
        </div>
      </div>

      <aside className="min-h-0 flex-1 overflow-y-auto border-t border-gray-200 bg-white md:w-[400px] md:flex-none md:border-l md:border-t-0">
        {selectedSite ? (
          <SitePanel site={selectedSite} trail={trail?.site_id === selectedSite.id ? trail : null} onClose={closePanel} onNeedSignup={closePanel} />
        ) : (
          <div className="space-y-4 p-5">
            <h2 className="text-lg font-semibold text-gray-900">Select a location</h2>
            <p className="text-sm text-gray-600">Click a pin to see the money trail behind it: which city agency funds it, how its payments are going, and what the XRPL payment agent did.</p>
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Get iMessage alerts</h3>
              <p className="mb-3 text-xs text-gray-600">Sign up to hear about free food and events you qualify for, texted through Photon.</p>
              <SignupForm />
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
