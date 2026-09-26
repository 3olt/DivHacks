// Open-data layer (/data): load EVERY record the API serves and flatten it into plain tables.
// Pure logic only (no React), so it runs in the browser and under tsx in Node for testing.
import type { AgencyStats, Contract, Decision, Nonprofit, Payment, Site, Trail } from "./contracts";
import type { Registry } from "./ledger";

export interface Health {
  ok: boolean;
  mode: "fixtures" | "mongo" | string;
  time: string;
  version: string;
}

export class HttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export type Getter = (path: string) => Promise<unknown>;

/** GET {baseUrl}{path} as JSON. Errors carry the API's machine code: "GET /agencies/X/stats -> 404 agency_not_found". */
export function httpGetter(baseUrl: string, fetchImpl: typeof fetch = fetch): Getter {
  const base = baseUrl.replace(/\/+$/, "");
  return async (path: string) => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { cache: "no-store" });
    } catch (err) {
      throw new HttpError(path, 0, "network_error", `GET ${path} -> network error (${err instanceof Error ? err.message : String(err)})`);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const code = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
      throw new HttpError(path, res.status, code, `GET ${path} -> ${res.status}${code ? ` ${code}` : ""}`);
    }
    return body;
  };
}

/** Run fn over items with at most `limit` in flight; results in input order, never throws. */
export async function mapSettled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Date-only ("2026-09-26", read as noon UTC) or full ISO timestamp -> epoch ms; null if missing or unparseable. */
export function toTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
  return Number.isNaN(t) ? null : t;
}
const time = (s: string) => toTime(s) ?? 0;

/** GET /decisions caps `limit` at 200 (docs/API.md). */
export const DECISIONS_FEED_LIMIT = 200;

export interface OpenDataset {
  api_url: string;
  loaded_at: string;
  sites: Site[];
  nonprofits: Nonprofit[];
  contracts: Contract[];
  payments: Payment[];
  decisions: Decision[];
  agencies: AgencyStats[];
  /** Partial failures (a trail, /decisions or an agency that did not load), with the API's error code. */
  warnings: string[];
}

export type TableData = Omit<OpenDataset, "api_url" | "loaded_at" | "warnings">;

/** Every agency code seen on sites, contracts and trails (upper-cased, sorted). */
export function agencyCodes(sites: Site[], trails: Trail[]): string[] {
  const codes = new Set<string>();
  for (const s of sites) if (s.agency_code) codes.add(s.agency_code.toUpperCase());
  for (const t of trails) {
    if (t.agency?.code) codes.add(t.agency.code.toUpperCase());
    for (const c of t.contracts ?? []) if (c.agency_code) codes.add(c.agency_code.toUpperCase());
  }
  return [...codes].sort();
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const it of items) {
    const k = key(it);
    if (!seen.has(k)) seen.set(k, it);
  }
  return [...seen.values()];
}

/**
 * Merge sites + their trails + GET /decisions into flat, de-duplicated tables:
 * nonprofits by ein, contracts by contract_id, payments by payment_id, decisions by decision_id, agencies by code.
 * `feed` (GET /decisions, newest first) wins over trail copies of the same decision.
 */
export function aggregate(sites: Site[], trails: Trail[], feed: Decision[] = [], agencyStats: AgencyStats[] = []): TableData {
  const nonprofits = dedupe(
    trails.map((t) => t.nonprofit).filter((n): n is Nonprofit => Boolean(n?.ein)),
    (n) => n.ein,
  ).sort((a, b) => a.ein.localeCompare(b.ein));

  const contracts = dedupe(
    trails.flatMap((t) => t.contracts ?? []),
    (c) => c.contract_id,
  ).sort((a, b) => a.contract_id.localeCompare(b.contract_id));

  const payments = dedupe(
    trails.flatMap((t) => t.payments ?? []),
    (p) => p.payment_id,
  )
    .map((p, i) => ({ p, i }))
    .sort((a, b) => time(a.p.date) - time(b.p.date) || a.i - b.i)
    .map((x) => x.p);

  const decisions = dedupe([...feed, ...trails.flatMap((t) => t.decisions ?? [])], (d) => d.decision_id)
    .map((d, i) => ({ d, i }))
    .sort((a, b) => time(b.d.created_at) - time(a.d.created_at) || a.i - b.i)
    .map((x) => x.d);

  const agencyMap = new Map<string, AgencyStats>();
  for (const t of trails) if (t.agency?.code) agencyMap.set(t.agency.code.toUpperCase(), t.agency);
  for (const a of agencyStats) agencyMap.set(a.code.toUpperCase(), a);
  const agencies = [...agencyMap.values()].sort((a, b) => a.code.localeCompare(b.code));

  return { sites: [...sites], nonprofits, contracts, payments, decisions, agencies };
}

/**
 * Load everything: GET /sites, GET /sites/:id/trail for every site (small concurrency), GET /decisions?limit=200,
 * then GET /agencies/:code/stats for every agency code seen. Throws only if /sites itself fails.
 */
export async function loadOpenData(baseUrl: string, opts: { get?: Getter; concurrency?: number } = {}): Promise<OpenDataset> {
  const get = opts.get ?? httpGetter(baseUrl);
  const concurrency = opts.concurrency ?? 4;
  const warnings: string[] = [];

  const sitesRaw = await get("/sites");
  if (!Array.isArray(sitesRaw)) throw new Error("GET /sites did not return an array");
  const sites = sitesRaw as Site[];

  const [trailResults, feedResult] = await Promise.all([
    mapSettled(sites, concurrency, (s) => get(`/sites/${encodeURIComponent(s.id)}/trail`) as Promise<Trail>),
    get(`/decisions?limit=${DECISIONS_FEED_LIMIT}`).then(
      (v) => ({ ok: true as const, v: v as Decision[] }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
  ]);
  const trails: Trail[] = [];
  trailResults.forEach((r, i) => {
    if (r.status === "fulfilled") trails.push(r.value);
    else warnings.push(`trail for ${sites[i].id}: ${errText(r.reason)}`);
  });
  const feed = feedResult.ok && Array.isArray(feedResult.v) ? feedResult.v : [];
  if (!feedResult.ok) warnings.push(`decisions feed: ${errText(feedResult.e)}`);
  else if (!Array.isArray(feedResult.v)) warnings.push("decisions feed: GET /decisions did not return an array");
  else if (feedResult.v.length >= DECISIONS_FEED_LIMIT) {
    warnings.push(`decisions feed: GET /decisions returned its maximum of ${DECISIONS_FEED_LIMIT}; older decisions appear only if a site trail includes them`);
  }

  const codes = agencyCodes(sites, trails);
  const agencyResults = await mapSettled(codes, concurrency, (c) => get(`/agencies/${encodeURIComponent(c)}/stats`) as Promise<AgencyStats>);
  const agencyStats: AgencyStats[] = [];
  agencyResults.forEach((r, i) => {
    if (r.status === "fulfilled") agencyStats.push(r.value);
    else warnings.push(`agency ${codes[i]}: ${errText(r.reason)}`);
  });

  return { api_url: baseUrl, loaded_at: new Date().toISOString(), ...aggregate(sites, trails, feed, agencyStats), warnings };
}

export async function loadHealth(baseUrl: string, get: Getter = httpGetter(baseUrl)): Promise<Health> {
  return (await get("/health")) as Health;
}

/** GET /xrpl/accounts: the public Testnet registry (addresses and roles). */
export async function loadRegistry(baseUrl: string, get: Getter = httpGetter(baseUrl)): Promise<Registry> {
  const reg = (await get("/xrpl/accounts")) as Registry;
  if (!reg || typeof reg.agent_account !== "string") throw new Error("GET /xrpl/accounts returned no agent_account");
  return reg;
}

// ---------------------------------------------------------------------------
// Labels and record helpers
// ---------------------------------------------------------------------------

/** Fixture tx hashes (00000000FA15E...) are placeholders that exist on no ledger. */
export const isFakeTxHash = (h: string | null | undefined): boolean => typeof h === "string" && h.toUpperCase().startsWith("00000000FA15E");
export const isRealTxHash = (h: string | null | undefined): h is string => typeof h === "string" && /^[0-9A-F]{64}$/i.test(h) && !isFakeTxHash(h);

/** Contracts carry no is_demo_data flag; fixture ones say so in `source`. */
export const isDemoContract = (c: Contract): boolean => /demo|fixture/i.test(c.source ?? "");
/**
 * Decisions carry no is_demo_data flag. Fixture / demo-scenario ones (api/src/fixtures, POST /demo/:scenario) have
 * rule_version "fixture-...", an id starting "fx_", reasoning starting "[fixture]", or a fake tx hash.
 */
export const isFixtureDecision = (d: Decision): boolean =>
  /^fixture/i.test(d.rule_version ?? "") || /^fx_/i.test(d.decision_id ?? "") || /^\[fixture\]/i.test(d.agent_reasoning ?? "") || isFakeTxHash(d.xrpl_tx_hash);

/** "1240000.00" USD -> "$1,240,000.00"; other currencies as given: "12.50 RLUSD". */
export function formatAmount(amount: string | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "";
  if (currency === "USD") {
    const n = Number(amount);
    if (Number.isFinite(n)) return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return currency ? `${amount} ${currency}` : amount;
}

/** Whole days from date-only a to date-only b (b - a). */
export function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Search, sort, CSV (used by every table)
// ---------------------------------------------------------------------------

/** Every whitespace-separated term of the query must appear in the (lower-cased) haystack. */
export function matchesQuery(haystackLower: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => haystackLower.includes(t));
}

export type SortValue = string | number | boolean | null | undefined;

/** Stable sort; empty values always last; numbers numerically, strings with natural ordering. */
export function sortRows<T>(rows: T[], value: (row: T) => SortValue, dir: "asc" | "desc"): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const empty = (v: SortValue) => v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      const ea = empty(a.v);
      const eb = empty(b.v);
      if (ea || eb) return ea === eb ? a.i - b.i : ea ? 1 : -1;
      let c: number;
      if (typeof a.v === "number" && typeof b.v === "number") c = a.v - b.v;
      else if (typeof a.v === "boolean" && typeof b.v === "boolean") c = Number(a.v) - Number(b.v);
      else c = String(a.v).localeCompare(String(b.v), "en", { numeric: true, sensitivity: "base" });
      return c * sign || a.i - b.i;
    })
    .map((x) => x.row);
}

/** Nested objects -> dotted keys; arrays of primitives -> "a; b"; arrays of objects -> JSON. */
export function flattenRecord(value: unknown, omit: string[] = [], prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = "";
    return out;
  }
  if (Array.isArray(value)) {
    out[prefix || "value"] = value.every((v) => v === null || typeof v !== "object") ? value.map((v) => (v === null ? "" : String(v))).join("; ") : JSON.stringify(value);
    return out;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    // An empty object still gets its column (as an empty cell) instead of silently disappearing.
    if (entries.length === 0 && prefix) out[prefix] = "";
    for (const [k, v] of entries) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (omit.includes(key)) continue;
      flattenRecord(v, omit, key, out);
    }
    return out;
  }
  out[prefix || "value"] = String(value);
  return out;
}

function csvCell(v: string): string {
  // Spreadsheet formula injection guard: untrusted text (e.g. invoice-derived reasoning) must not run as a formula.
  let s = v;
  if (/^[=+@\t\r]/.test(s) || (s.startsWith("-") && !/^-\d+(\.\d+)?$/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Records -> CSV (RFC 4180, CRLF). Columns = union of flattened keys in first-seen order. */
export function toCsv(records: unknown[], omit: string[] = []): string {
  const flat = records.map((r) => flattenRecord(r, omit));
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const f of flat)
    for (const k of Object.keys(f))
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
  // A null object field ("memo": null) must not add a bare "memo" column next to "memo.inv", "memo.ctr", ...
  const nested = new Set(cols.flatMap((c) => c.split(".").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("."))));
  for (let i = cols.length - 1; i >= 0; i--) if (nested.has(cols[i])) cols.splice(i, 1);
  const lines = [cols.map(csvCell).join(",")];
  for (const f of flat) lines.push(cols.map((c) => csvCell(f[c] ?? "")).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
