"use client";

import "leaflet/dist/leaflet.css";
import { CircleMarker, MapContainer, Popup, TileLayer, useMapEvents } from "react-leaflet";
import type { Site } from "@/lib/contracts";
import { RISK_COLORS } from "@/lib/risk";
import SitePopup from "./SitePopup";

const NYC_CENTER: [number, number] = [40.7128, -73.95];

export default function MapView({
  sites,
  selectedId,
  onSelect,
  onPopupChange,
}: {
  sites: Site[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPopupChange: (open: boolean) => void;
}) {
  return (
    <MapContainer center={NYC_CENTER} zoom={11} className="h-full w-full" zoomControl={false}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <PopupWatcher onChange={onPopupChange} />
      {sites.map((site) => {
        const [lng, lat] = site.location.coordinates;
        const selected = site.id === selectedId;
        return (
          <CircleMarker
            key={site.id}
            center={[lat, lng]}
            radius={selected ? 13 : 9}
            pathOptions={{
              color: selected ? "#111827" : "#ffffff",
              weight: selected ? 3 : 2,
              fillColor: RISK_COLORS[site.risk.level],
              fillOpacity: 0.95,
            }}
          >
            <Popup offset={[0, -6]} closeButton>
              <SitePopup site={site} onOpenDetails={() => onSelect(site.id)} />
            </Popup>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}

function PopupWatcher({ onChange }: { onChange: (open: boolean) => void }) {
  useMapEvents({ popupopen: () => onChange(true), popupclose: () => onChange(false) });
  return null;
}
