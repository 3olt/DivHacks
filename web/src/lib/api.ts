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

export const DEMO_SCENARIOS = [
  "happy",
  "injection",
  "duplicate",
  "over-contract",
  "address-swap",
  "over-limit",
  "kill-switch",
  // PLACEHOLDER — simulated escrow (api/src/demo/escrowPlaceholder.ts). Remove these two with it.
  "escrow",
  "escrow-release",
] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

export async function runDemo(scenario: DemoScenario): Promise<void> {
  const res = await fetch(`${API_URL}/demo/${scenario}`, { method: "POST" });
  if (!res.ok) throw new Error(`Demo ${scenario} failed: ${res.status}`);
}

export async function resetDemo(): Promise<void> {
  await fetch(`${API_URL}/dev/reset`, { method: "POST" });
}
