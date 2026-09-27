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
  const markers = useRef(new Map<string, L.Marker>());

  return (
    <MapContainer bounds={NYC_BOUNDS} zoomSnap={0.25} closePopupOnClick={false} className="h-full w-full" zoomControl={false}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <PopupWatcher onChange={onPopupChange} onDismiss={onDismiss} />
      {sites.map((site) => {
        const [lng, lat] = site.location.coordinates;
        return (
          <Marker
            key={site.id}
            position={[lat, lng]}
            icon={pinIcon(site.risk.level, site.id === selectedId)}
            title={site.name}
            ref={(m) => {
              if (m) markers.current.set(site.id, m);
              else markers.current.delete(site.id);
            }}
            eventHandlers={{ click: () => onSelect(site.id) }}
          >
            <Popup closeButton autoPan={false}>
              <SitePopup site={site} />
            </Popup>
          </Marker>
        );
      })}
      {/* After the markers: effects run in order, so the selected marker is on the map before its popup opens. */}
      <FlyToSelection site={selected} markers={markers} />
    </MapContainer>
  );
}

// Zooms to the selected site (placed below center so its popup fits) and opens its popup, so selecting from
// the ledger behaves like clicking the pin. Zooms back to all of NYC when cleared.
function FlyToSelection({ site, markers }: { site: Site | null; markers: React.RefObject<Map<string, L.Marker>> }) {
  const map = useMap();
  const lng = site?.location.coordinates[0];
  const lat = site?.location.coordinates[1];
  const id = site?.id;
  useEffect(() => {
    // A map with no size yet (cold load, hidden container) makes fly/zoom math produce NaN coordinates.
    const size = map.getSize();
    if (size.x === 0 || size.y === 0) return;
    if (lat === undefined || lng === undefined) {
      map.closePopup();
      map.flyToBounds(NYC_BOUNDS, { duration: 0.6 });
      return;
    }
    const zoom = Math.max(map.getZoom(), SITE_ZOOM);
    const offset = Math.min(120, map.getSize().y / 4);
    const target = map.unproject(map.project([lat, lng], zoom).subtract([0, offset]), zoom);
    map.flyTo(target, zoom, { duration: 0.6 });
    // Next tick: a marker that just mounted (e.g. its type was un-filtered) may be re-created once more.
    const t = setTimeout(() => {
      const marker = id ? markers.current.get(id) : undefined;
      if (marker && !marker.isPopupOpen()) marker.openPopup();
    }, 0);
    return () => clearTimeout(t);
  }, [map, markers, id, lat, lng]);
  return null;
}

// A popup closing counts as "dismiss" (same as the panel's ✕) unless another popup opened right after
// (the user clicked a different pin) or its marker was being removed from the map (filtered out, or
// React re-mounting it), which closes the popup without the user asking.
function PopupWatcher({ onChange, onDismiss }: { onChange: (open: boolean) => void; onDismiss: () => void }) {
  const opens = useRef(0);
  const map = useMapEvents({
    popupopen: () => {
      opens.current++;
      onChange(true);
    },
    popupclose: (e) => {
      // Leaflet has no public getter for a popup's owner layer; _source is stable across 1.x.
      const source = (e.popup as unknown as { _source?: L.Layer })._source;
      if (source && !map.hasLayer(source)) return;
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
