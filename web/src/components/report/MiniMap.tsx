"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { MapContainer, Marker, TileLayer } from "react-leaflet";
import type { Site } from "@/lib/contracts";
import { RISK_COLORS } from "@/lib/risk";

// Static locator map for the report page (same pin style as the main map).
export default function MiniMap({ site }: { site: Site }) {
  const [lng, lat] = site.location.coordinates;
  const icon = L.divIcon({
    className: "",
    html: `<span class="map-pin map-pin--selected" style="--pin-color:${RISK_COLORS[site.risk.level]}"></span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
  return (
    <MapContainer
      center={[lat, lng]}
      zoom={15}
      className="h-full w-full"
      zoomControl={false}
      dragging={false}
      scrollWheelZoom={false}
      doubleClickZoom={false}
      touchZoom={false}
      keyboard={false}
      attributionControl={false}
    >
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <Marker position={[lat, lng]} icon={icon} interactive={false} />
    </MapContainer>
  );
}
