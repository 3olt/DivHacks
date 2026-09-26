// Client for the backend API (api/, docs/API.md). The browser calls it directly (CORS is open).
import type { AgencyStats, Decision, Site, Trail } from "./contracts";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchSites = () => get<Site[]>("/sites");
export const fetchSite = (id: string) => get<Site>(`/sites/${encodeURIComponent(id)}`);
export const fetchTrail = (id: string) => get<Trail>(`/sites/${encodeURIComponent(id)}/trail`);
export const fetchDecisions = (limit = 50) => get<Decision[]>(`/decisions?limit=${limit}`);
export const fetchAgencyStats = (code: string) => get<AgencyStats>(`/agencies/${encodeURIComponent(code)}/stats`);
