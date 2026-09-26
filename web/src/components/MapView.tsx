"use client";

import "leaflet/dist/leaflet.css";
import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import type { Site } from "@/lib/types";
import { RISK_COLORS } from "@/lib/risk";

const NYC_CENTER: [number, number] = [40.7128, -73.95];

export default function MapView({
  sites,
  selectedId,
  onSelect,
}: {
  sites: Site[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <MapContainer center={NYC_CENTER} zoom={11} className="h-full w-full" zoomControl={false}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
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
            eventHandlers={{ click: () => onSelect(site.id) }}
          >
            <Tooltip direction="top" offset={[0, -8]}>
              {site.name}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
