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

// Scenario names accepted by POST /demo/:scenario (docs/API.md). In mongo mode each one starts a REAL XRPL Testnet run
// (happy runs the golden site); `escrow` and `uncredentialed` are Testnet-only (409 testnet_only in fixture mode).
export const DEMO_SCENARIOS = [
  "happy",
  "injection",
  "duplicate",
  "over-contract",
  "uncredentialed",
  "address-swap",
  "over-limit",
  "kill-switch",
  "escrow",
] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

export type DemoStart =
  | { ok: true; run_id: string | null; status: string; message?: string }
  | { ok: false; error: string; message: string; run_id?: string };

// Mongo mode: 202 {run_id, status:"started"} at once; decisions arrive over WS; a `demo_run` message says when it ends.
// Fixture mode: 202 with the synthesized decision (run_id absent). 409 = a run is already going / Testnet-only.
export async function runDemo(scenario: DemoScenario): Promise<DemoStart> {
  const res = await fetch(`${API_URL}/demo/${scenario}`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error ?? `http_${res.status}`, message: body.message ?? `Failed (${res.status})`, run_id: body.run_id };
  return { ok: true, run_id: body.run_id ?? null, status: body.status ?? "done", message: body.message };
}

export async function fetchDemoRun(runId: string): Promise<{ status: string } | null> {
  const res = await fetch(`${API_URL}/demo/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
  return res.ok ? res.json() : null;
}

export async function resetDemo(): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`${API_URL}/dev/reset`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true } : { ok: false, message: body.message ?? `Reset failed (${res.status})` };
}
