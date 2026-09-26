"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useRef } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import type { RiskLevel, Site } from "@/lib/contracts";
import { RISK_COLORS } from "@/lib/risk";
import SitePopup from "./SitePopup";

// The five boroughs; the start view fits these to the screen.
const NYC_BOUNDS: L.LatLngBoundsExpression = [
  [40.5, -74.26],
  [40.92, -73.7],
];
const SITE_ZOOM = 13;
// Hit area is the full 36px box; the visible dot is smaller (see .map-pin in globals.css).
const PIN_SIZE = 36;

// Cached so re-renders don't replace the marker's DOM (which would restart hover transitions).
const iconCache = new Map<string, L.DivIcon>();

function pinIcon(level: RiskLevel, selected: boolean): L.DivIcon {
  const key = `${level}:${selected}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const icon = L.divIcon({
    className: "",
    html: `<span class="map-pin${selected ? " map-pin--selected" : ""}" style="--pin-color:${RISK_COLORS[level]}"></span>`,
    iconSize: [PIN_SIZE, PIN_SIZE],
    iconAnchor: [PIN_SIZE / 2, PIN_SIZE / 2],
    popupAnchor: [0, -12],
  });
  iconCache.set(key, icon);
  return icon;
}

export default function MapView({
  sites,
  selectedId,
  onSelect,
  onPopupChange,
  onDismiss,
}: {
  sites: Site[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPopupChange: (open: boolean) => void;
  onDismiss: () => void;
}) {
  const selected = sites.find((s) => s.id === selectedId) ?? null;

  return (
    <MapContainer bounds={NYC_BOUNDS} zoomSnap={0.25} closePopupOnClick={false} className="h-full w-full" zoomControl={false}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <PopupWatcher onChange={onPopupChange} onDismiss={onDismiss} />
      <FlyToSelection site={selected} />
      {sites.map((site) => {
        const [lng, lat] = site.location.coordinates;
        return (
          <Marker
            key={site.id}
            position={[lat, lng]}
            icon={pinIcon(site.risk.level, site.id === selectedId)}
            eventHandlers={{ click: () => onSelect(site.id) }}
          >
            <Popup closeButton autoPan={false}>
              <SitePopup site={site} />
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}

// Zooms to the selected site (placed below center so its popup fits), or back to all of NYC when cleared.
function FlyToSelection({ site }: { site: Site | null }) {
  const map = useMap();
  const lng = site?.location.coordinates[0];
  const lat = site?.location.coordinates[1];
  useEffect(() => {
    if (lat === undefined || lng === undefined) {
      map.closePopup();
      map.flyToBounds(NYC_BOUNDS, { duration: 0.6 });
      return;
    }
    const zoom = Math.max(map.getZoom(), SITE_ZOOM);
    const offset = Math.min(120, map.getSize().y / 4);
    const target = map.unproject(map.project([lat, lng], zoom).subtract([0, offset]), zoom);
    map.flyTo(target, zoom, { duration: 0.6 });
  }, [map, lat, lng]);
  return null;
}

// A popup closing counts as "dismiss" (same as the panel's ✕) unless another popup opened right after,
// which is what happens when the user clicks a different pin.
function PopupWatcher({ onChange, onDismiss }: { onChange: (open: boolean) => void; onDismiss: () => void }) {
  const opens = useRef(0);
  useMapEvents({
    popupopen: () => {
      opens.current++;
      onChange(true);
    },
    popupclose: () => {
      const seen = opens.current;
      setTimeout(() => {
        if (opens.current !== seen) return;
        onChange(false);
        onDismiss();
      }, 0);
    },
  });
  return null;
}
