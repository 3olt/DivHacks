"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { Site, SiteDetail } from "@/lib/types";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";
import SitePanel from "./SitePanel";
import SignupForm from "./SignupForm";

const MapView = dynamic(() => import("./MapView"), { ssr: false });

const POLL_MS = 4000;

export default function Dashboard() {
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SiteDetail | null>(null);

  // Poll so pins update live when the XRPL agent posts a payment.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch("/api/sites");
      if (!cancelled && res.ok) setSites(await res.json());
      if (selectedId) {
        const d = await fetch(`/api/sites/${selectedId}`);
        if (!cancelled && d.ok) setDetail(await d.json());
      }
    }
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [selectedId]);

  function closePanel() {
    setSelectedId(null);
    setDetail(null);
  }

  const counts = sites.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.risk.level]: (acc[s.risk.level] ?? 0) + 1 }), {});

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <div className="relative h-[55dvh] md:h-full md:flex-1">
        <MapView sites={sites} selectedId={selectedId} onSelect={setSelectedId} />
        <div className="pointer-events-none absolute left-3 top-3 z-[1000] max-w-xs rounded-lg bg-white/95 p-4 shadow-md">
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
        </div>
      </div>

      <aside className="min-h-0 flex-1 overflow-y-auto border-t border-gray-200 bg-white md:w-[400px] md:flex-none md:border-l md:border-t-0">
        {detail && detail.site.id === selectedId ? (
          <SitePanel detail={detail} onClose={closePanel} onNeedSignup={closePanel} />
        ) : (
          <div className="space-y-4 p-5">
            <h2 className="text-lg font-semibold text-gray-900">Select a location</h2>
            <p className="text-sm text-gray-600">Click a pin to see the money trail behind it: which city agency funds it, how late payments are, and verified payments on the XRP Ledger.</p>
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Get iMessage alerts</h3>
              <p className="mb-3 text-xs text-gray-600">Free food, events, and funding updates near you, texted through Photon.</p>
              <SignupForm />
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
