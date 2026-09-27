// READ-ONLY smoke test against a RUNNING api server in MONGO mode: the shape of every GET endpoint, the /sites filters,
// the WS hello, and the guards (which reject without writing). It never starts a demo run, never resets and never posts
// an event that is accepted.
//   API_URL=http://localhost:4000 npm run smoke:mongo -w api
// Prints PASS/FAIL per assertion and exits 1 on any failure. Sends EVENTS_TOKEN / SUBSCRIBERS_TOKEN from the root .env.
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import WebSocket from "ws";
import { CHECK_NAMES } from "../../shared/contracts";
import type { AgencyStats, Decision, LiveMessage, Site, Trail } from "../../shared/contracts";

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env"), quiet: true });
const API = (process.env.SMOKE_API_URL ?? process.env.API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const EVENTS_TOKEN = process.env.EVENTS_TOKEN || "";
const SUBSCRIBERS_TOKEN = process.env.SUBSCRIBERS_TOKEN || "";
const DEV_ROUTES = /^(1|true|yes)$/i.test(process.env.DEV_ROUTES ?? "");

let passed = 0;
let failed = 0;
function check(name: string, ok: unknown, detail?: unknown): boolean {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail !== undefined ? ` -- ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
  return Boolean(ok);
}

async function get<T = any>(p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${p}`, { headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: body as T };
}
async function post<T = any>(p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${p}`, { method: "POST", headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed as T };
}

// Independent decision-hash / memo-hash re-implementation (docs/API.md), kept separate from shared/hash.ts.
function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}
const HASHED = ["decision_id", "invoice_id", "contract_id", "payee_ein", "amount", "currency", "agent_reasoning", "rule_version", "source_tag", "created_at"] as const;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hashOf = (d: Decision) => sha256(canonical(Object.fromEntries(HASHED.map((k) => [k, d[k]]))));
const memoHashOf = (d: Decision) => sha256(JSON.stringify({ inv: d.invoice_id, ctr: d.contract_id, ein: d.payee_ein, dh: d.decision_hash, rv: d.rule_version }));

const t = (s: string) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
const levelFor = (score: number) => (score >= 70 ? "red" : score >= 40 ? "yellow" : "green");
const TYPES = ["food_pantry", "grocery_giveaway", "shelter", "youth_program", "event"];
const OUTCOMES = ["released", "held_escrow", "pending_approval", "refused"];
const ENFORCERS = ["cosigner", "ledger", "hold", null];
function haversine(a: [number, number], b: [number, number]): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(b[1] - a[1]) / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(r(b[0] - a[0]) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

function siteShapeProblems(s: Site): string[] {
  const out: string[] = [];
  const x = s as unknown as Record<string, unknown>;
  if ("_id" in x) out.push("_id present");
  for (const k of ["id", "name", "borough", "zip", "nonprofit_ein", "agency_code"]) if (typeof x[k] !== "string" || !x[k]) out.push(`${k} not a string`);
  if (!TYPES.includes(s.type)) out.push(`type ${s.type}`);
  const c = s.location?.coordinates;
  if (s.location?.type !== "Point" || !Array.isArray(c) || c.length !== 2 || !c.every((n) => typeof n === "number") || c[0] > -73 || c[0] < -75 || c[1] < 40 || c[1] > 41.5) out.push("location not a NYC [lng,lat] Point");
  if (!Array.isArray(s.contract_ids) || !s.contract_ids.length) out.push("contract_ids empty");
  if (!Array.isArray(s.events) || !s.events.every((e) => typeof e.title === "string" && !Number.isNaN(Date.parse(e.starts_at)) && e.is_demo_data === true)) out.push("events");
  const r = s.risk;
  if (!r || !["green", "yellow", "red"].includes(r.level) || typeof r.score !== "number" || r.score < 0 || r.score > 100 || levelFor(r.score) !== r.level) out.push(`risk level/score ${r?.level} ${r?.score}`);
  if (!Array.isArray(r?.reasons) || !r.reasons.length || typeof r.summary !== "string" || Number.isNaN(Date.parse(r.computed_at))) out.push("risk reasons/summary/computed_at");
  if (typeof s.is_demo_data !== "boolean") out.push("is_demo_data");
  return out;
}

function decisionShapeProblems(d: Decision): string[] {
  const out: string[] = [];
  const x = d as unknown as Record<string, unknown>;
  if ("_id" in x) out.push("_id present");
  if ("audit" in x) out.push("audit served");
  for (const k of ["decision_id", "invoice_id", "contract_id", "payee_ein", "amount", "agent_reasoning", "decision_hash", "rule_version", "created_at"]) if (typeof x[k] !== "string") out.push(`${k}`);
  if (!/^\d+(\.\d+)?$/.test(d.amount)) out.push("amount");
  if (!["RLUSD", "XRP", "CTT"].includes(d.currency)) out.push(`currency ${d.currency}`);
  if (!OUTCOMES.includes(d.outcome)) out.push(`outcome ${d.outcome}`);
  if (!ENFORCERS.includes(d.enforced_by)) out.push(`enforced_by ${d.enforced_by}`);
  if (!Array.isArray(d.refusal_reasons) || !Array.isArray(d.signers)) out.push("arrays");
  // Payment decisions: the 8 CHECK_NAMES in order. Simulated-escrow (CTT) decisions that reached the co-signer carry its
  // escrow_* checks instead; a CTT decision stopped before (e.g. verifier_rejected) has the 8 standard "not evaluated" ones.
  const eight = Array.isArray(d.checks) && d.checks.length === 8 && d.checks.every((c, i) => c.name === CHECK_NAMES[i] && typeof c.passed === "boolean" && typeof c.detail === "string");
  const escrowChecks = Array.isArray(d.checks) && d.checks.length > 0 && d.checks.every((c) => c.name.startsWith("escrow_") && typeof c.passed === "boolean" && typeof c.detail === "string");
  if (!(eight || (d.currency === "CTT" && escrowChecks))) out.push(d.currency === "CTT" ? "checks (8 CHECK_NAMES or escrow_*)" : "checks (8, CHECK_NAMES order)");
  if (typeof d.source_tag !== "number") out.push("source_tag");
  if (d.outcome === "released" && (!d.xrpl_tx_hash || d.ledger_result !== "tesSUCCESS")) out.push("released without tx/tesSUCCESS");
  return out;
}

async function main(): Promise<void> {
  console.log(`Mongo smoke test (read-only) against ${API}\n`);
  const health = await get("/health");
  check("GET /health 200 ok:true mode:mongo (+ demo_run)", health.status === 200 && health.body?.ok === true && health.body?.mode === "mongo" && "demo_run" in health.body, health.body);
  if (health.body?.mode !== "mongo") {
    console.log("\nnot a mongo-mode server: stopping");
    process.exit(1);
  }

  // ---- WS hello ----
  const hello = await new Promise<LiveMessage | null>((resolve) => {
    const ws = new WebSocket(`${API.replace(/^http/, "ws")}/live`);
    const timer = setTimeout(() => (ws.close(), resolve(null)), 5000);
    ws.once("message", (d) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(String(d)) as LiveMessage);
    });
    ws.once("error", () => resolve(null));
  });
  check("WS /live sends hello {mode:mongo, server_time}", hello?.type === "hello" && hello.mode === "mongo" && !Number.isNaN(Date.parse(hello.server_time)), hello);
  const plainLive = await get("/live");
  check("GET /live without upgrade -> 426", plainLive.status === 426 && plainLive.body?.error === "upgrade_required");

  // ---- sites ----
  const sitesRes = await get<Site[]>("/sites");
  const sites = sitesRes.body;
  check("GET /sites -> 200 bare array", sitesRes.status === 200 && Array.isArray(sites), typeof sites);
  const bad = sites.map((s) => ({ id: s.id, p: siteShapeProblems(s) })).filter((x) => x.p.length);
  check(`every Site has the documented shape (${sites.length} sites)`, bad.length === 0, bad);
  const real = sites.filter((s) => !s.is_demo_data);
  const demo = sites.filter((s) => s.is_demo_data);
  check("15 real sites (is_demo_data false) + 4 demo sites site_001..site_004", real.length === 15 && demo.map((s) => s.id).join() === "site_001,site_002,site_003,site_004", { real: real.length, demo: demo.map((s) => s.id) });
  check("demo sites are labelled: name ends in (demo), demo_note, nonprofit 00-000000N", demo.every((s) => s.name.endsWith("(demo)") && typeof s.demo_note === "string" && /^00-000000\d$/.test(s.nonprofit_ein)));
  check("GET /sites sorted by id", sites.map((s) => s.id).join() === [...sites.map((s) => s.id)].sort().join());
  check('real sites: every seeded event title ends in "(demo event)"; demo sites are not suffixed', real.every((s) => s.events.every((e) => e.title.endsWith(" (demo event)"))) && demo.every((s) => s.events.every((e) => !e.title.endsWith("(demo event)"))), real[0]?.events);
  const golden = sites.find((s) => s.id === "site_fbnyc");
  check("golden site_fbnyc: real, Food Bank For NYC, EIN 13-3179546, is_golden, risk.components", !!golden && golden.is_demo_data === false && golden.nonprofit_ein === "13-3179546" && golden.is_golden === true && !!golden.risk.components, golden?.risk);

  const shelters = await get<Site[]>("/sites?type=shelter");
  check("GET /sites?type=shelter -> only shelters (5)", shelters.status === 200 && shelters.body.length === 5 && shelters.body.every((s) => s.type === "shelter"), shelters.body.length);
  const two = await get<Site[]>("/sites?type=food_pantry,youth_program");
  check("GET /sites?type=food_pantry,youth_program -> only those types", two.status === 200 && two.body.length > 0 && two.body.every((s) => ["food_pantry", "youth_program"].includes(s.type)) && two.body.length === sites.filter((s) => ["food_pantry", "youth_program"].includes(s.type)).length);
  const badType = await get("/sites?type=museum");
  check("GET /sites?type=museum -> 400 invalid_type", badType.status === 400 && badType.body?.error === "invalid_type");
  const bbox: [number, number, number, number] = [-73.95, 40.79, -73.85, 40.87];
  const inBox = await get<Site[]>(`/sites?bbox=${bbox.join(",")}`);
  const expectBox = sites.filter(({ location: { coordinates: [x, y] } }) => x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3]).map((s) => s.id);
  check(`GET /sites?bbox=... ($geoWithin) -> exactly the sites inside (${expectBox.length})`, inBox.status === 200 && inBox.body.map((s) => s.id).join() === expectBox.join(), { got: inBox.body.map?.((s) => s.id), expectBox });
  for (const q of ["bbox=1,2,3", "bbox=-73.8,40.9,-73.9,40.8", "bbox=a,b,c,d"]) {
    const r = await get(`/sites?${q}`);
    check(`GET /sites?${q} -> 400 invalid_bbox`, r.status === 400 && r.body?.error === "invalid_bbox");
  }
  const center: [number, number] = [-73.8729, 40.8078];
  const near = await get<Site[]>(`/sites?near=${center.join(",")}&radius_m=6000`);
  const dists = near.body.map((s) => haversine(center, s.location.coordinates));
  const expectNear = sites.filter((s) => haversine(center, s.location.coordinates) <= 6000 * 0.995).map((s) => s.id);
  check("GET /sites?near=...&radius_m=6000 ($geoNear) -> within radius, nearest first, golden first", near.status === 200 && near.body[0]?.id === "site_fbnyc" && dists.every((d, i) => d <= 6000 * 1.005 && (i === 0 || dists[i - 1] <= d + 1)) && expectNear.every((id) => near.body.some((s) => s.id === id)), { ids: near.body.map?.((s) => s.id), dists });
  const nearAll = await get<Site[]>(`/sites?near=${center.join(",")}&radius_m=50000&type=food_pantry&bbox=-74.3,40.4,-73.6,41`);
  check("GET /sites near + type + bbox combine (AND), nearest first", nearAll.status === 200 && nearAll.body.length > 0 && nearAll.body.every((s) => s.type === "food_pantry") && nearAll.body.map((s) => haversine(center, s.location.coordinates)).every((d, i, a) => i === 0 || a[i - 1] <= d + 1), nearAll.body.map?.((s) => s.id));
  const nearDefault = await get<Site[]>(`/sites?near=${center.join(",")}`);
  check("GET /sites?near= (default radius 2000 m)", nearDefault.status === 200 && nearDefault.body.every((s) => haversine(center, s.location.coordinates) <= 2000 * 1.005));
  for (const [q, code] of [["near=1", "invalid_near"], ["near=-200,40", "invalid_near"], [`near=${center.join(",")}&radius_m=0`, "invalid_radius"], [`near=${center.join(",")}&radius_m=50001`, "invalid_radius"]]) {
    const r = await get(`/sites?${q}`);
    check(`GET /sites?${q} -> 400 ${code}`, r.status === 400 && r.body?.error === code);
  }

  const one = await get<Site>("/sites/site_fbnyc");
  check("GET /sites/site_fbnyc -> 200, same as the listing", one.status === 200 && JSON.stringify(one.body) === JSON.stringify(golden));
  const missing = await get("/sites/site_999");
  check("GET /sites/site_999 -> 404 site_not_found", missing.status === 404 && missing.body?.error === "site_not_found");

  // ---- trails ----
  const tr = await get<Trail>("/sites/site_fbnyc/trail");
  const trail = tr.body;
  check("GET /sites/site_fbnyc/trail -> 200 {site_id, agency, contracts, payments, nonprofit, decisions}", tr.status === 200 && Object.keys(trail).join() === "site_id,agency,contracts,payments,nonprofit,decisions" && trail.site_id === "site_fbnyc");
  check("trail agency = agency_stats HRA (real, fraction, source)", trail.agency.code === "HRA" && typeof trail.agency.pct_contracts_registered_late === "number" && trail.agency.pct_contracts_registered_late < 1 && trail.agency.is_demo_data === false && !!trail.agency.source_url);
  check("trail contracts in site.contract_ids order", trail.contracts.map((c) => c.contract_id).join() === golden!.contract_ids.join());
  const gc = trail.contracts.find((c) => c.contract_id === "CT106920258801736");
  check("golden contract: end_date_assumed true, end_date_loaded 2026-06-30, end_date_note, real spent_to_date", gc?.end_date_assumed === true && gc.end_date_loaded === "2026-06-30" && typeof gc.end_date_note === "string" && typeof gc.spent_to_date === "string", gc && { a: gc.end_date_assumed, l: gc.end_date_loaded });
  check("golden contract served with its REAL end: end_date = end_date_loaded 2026-06-30, end_date_demo_assumed 2027-06-30", gc?.end_date === "2026-06-30" && gc.end_date_demo_assumed === "2027-06-30", gc && { e: gc.end_date, d: gc.end_date_demo_assumed });
  check("trail payments oldest first", trail.payments.map((p) => t(p.date)).every((x, i, a) => i === 0 || a[i - 1] <= x));
  const ids = new Set(golden!.contract_ids);
  check("trail payments all belong to the site's contracts; Checkbook = USD, XRPL = RLUSD/CTT", trail.payments.every((p) => ids.has(p.contract_id) && (p.source === "checkbook" ? p.currency === "USD" : ["RLUSD", "CTT"].includes(p.currency))));
  const cb = trail.payments.filter((p) => p.source === "checkbook");
  check(`golden trail has the 19 real Checkbook payments (got ${cb.length})`, cb.length === 19 && cb.every((p) => p.is_demo_data === false && /^\d{4}-\d{2}-\d{2}$/.test(p.date)));
  const onLedger = trail.payments.filter((p) => p.source === "xrpl" && p.xrpl_tx_hash);
  check("XRPL payments on-ledger carry explorer_url (testnet.xrpl.org) + memo_hash", onLedger.length > 0 && onLedger.every((p) => p.explorer_url === `https://testnet.xrpl.org/transactions/${p.xrpl_tx_hash}` && /^[0-9a-f]{64}$/.test(p.memo_hash ?? "")));
  const memoOk = onLedger.filter((p) => {
    const d = trail.decisions.find((x) => x.xrpl_tx_hash === p.xrpl_tx_hash);
    return d && memoHashOf(d) === p.memo_hash;
  });
  check(`memo_hash = sha256 of the on-ledger MemoData JSON (${memoOk.length}/${onLedger.length})`, memoOk.length === onLedger.length);
  check("trail nonprofit: Food Bank For NYC, public fields + wallet whitelist only", trail.nonprofit.ein === "13-3179546" && !!trail.nonprofit.financials && trail.nonprofit.wallet?.credential_status === "valid" && Object.keys(trail.nonprofit.wallet!).every((k) => ["address", "credential_status", "credential_expires", "bank_verified", "label", "is_demo_data"].includes(k)) && !("crosswalk_method" in trail.nonprofit), trail.nonprofit.wallet);
  check("trail decisions newest first, for the site's contracts", trail.decisions.every((d, i, a) => (i === 0 || a[i - 1].created_at >= d.created_at) && ids.has(d.contract_id)));
  const dBad = trail.decisions.map((d) => ({ id: d.decision_id, p: decisionShapeProblems(d) })).filter((x) => x.p.length);
  check("trail decisions: documented shape, 8 checks, no audit, no _id", dBad.length === 0, dBad);
  check("no _id anywhere in the trail", !JSON.stringify(trail).includes('"_id"'));

  // spent_to_date null (not loaded) is served as null, never "0"
  let nulls = 0;
  for (const s of real.filter((x) => x.id !== "site_fbnyc")) {
    const r = await get<Trail>(`/sites/${s.id}/trail`);
    if (r.status !== 200) {
      check(`GET /sites/${s.id}/trail -> 200`, false, r.status);
      continue;
    }
    nulls += r.body.contracts.filter((c) => c.spent_to_date === null).length;
    if (r.body.contracts.some((c) => c.spent_to_date === "0" || (c.spent_to_date === "0.00" && c.spent_to_date_note?.includes("not loaded")))) check(`${s.id}: a not-loaded spent_to_date coerced to 0`, false);
  }
  check(`real trails: spent_to_date null (not loaded) served as null (${nulls} contracts)`, nulls > 0);
  const demoTrail = await get<Trail>("/sites/site_001/trail");
  check("GET /sites/site_001/trail (demo site): np_1 nonprofit + wallet, its demo contract, its decisions", demoTrail.status === 200 && demoTrail.body.nonprofit.ein === "00-0000001" && demoTrail.body.contracts[0]?.contract_id === "CT1-069-20261409087" && demoTrail.body.decisions.every((d) => d.contract_id === "CT1-069-20261409087"), demoTrail.body?.contracts?.map?.((c) => c.contract_id));
  const tr404 = await get("/sites/site_999/trail");
  check("GET /sites/site_999/trail -> 404 site_not_found", tr404.status === 404 && tr404.body?.error === "site_not_found");

  // ---- agencies ----
  for (const code of ["hra", "DHS", "dycd"]) {
    const a = await get<AgencyStats>(`/agencies/${code}/stats`);
    check(`GET /agencies/${code}/stats -> 200 (case-insensitive), no _id`, a.status === 200 && a.body.code === code.toUpperCase() && typeof a.body.pct_contracts_registered_late === "number" && !("_id" in a.body) && !!a.body.source_url);
  }
  const nypd = await get("/agencies/NYPD/stats");
  check("GET /agencies/NYPD/stats -> 404 agency_not_found", nypd.status === 404 && nypd.body?.error === "agency_not_found");

  // ---- decisions ----
  const decs = await get<Decision[]>("/decisions");
  check("GET /decisions -> 200, default limit 50", decs.status === 200 && Array.isArray(decs.body) && decs.body.length > 0 && decs.body.length <= 50, decs.body.length);
  check("GET /decisions newest first", decs.body.every((d, i, a) => i === 0 || t(a[i - 1].created_at) >= t(d.created_at)));
  const all = await get<Decision[]>("/decisions?limit=200");
  const allBad = all.body.map((d) => ({ id: d.decision_id, p: decisionShapeProblems(d) })).filter((x) => x.p.length);
  check(`GET /decisions?limit=200: every decision has the documented shape (${all.body.length})`, allBad.length === 0, allBad.slice(0, 5));
  // decision_hash = hash of its own pre-signing fields, except an officer-approved execution (approved_from): it carries
  // the PENDING decision's hash, which its memo commits to.
  const byId = new Map(all.body.map((d) => [d.decision_id, d]));
  const own = all.body.filter((d) => !d.approved_from);
  const executed = all.body.filter((d) => d.approved_from);
  const ownOk = own.filter((d) => hashOf(d) === d.decision_hash);
  check(`decision_hash recomputes from the decision's own fields (${ownOk.length}/${own.length})`, ownOk.length === own.length, own.filter((d) => hashOf(d) !== d.decision_hash).map((d) => d.decision_id).slice(0, 5));
  const execOk = executed.filter((d) => {
    const p = byId.get(d.approved_from!);
    return !p || (p.outcome === "pending_approval" && hashOf(p) === d.decision_hash);
  });
  check(`officer-approved executions (approved_from) carry the pending decision's hash (${execOk.length}/${executed.length})`, execOk.length === executed.length && executed.every((d) => d.signers.includes("officer")), executed.map((d) => d.decision_id).slice(0, 5));
  check("real decisions include a ledger tefBAD_QUORUM and a CTT escrow decision", all.body.some((d) => d.ledger_result === "tefBAD_QUORUM" && d.enforced_by === "ledger") && all.body.some((d) => d.currency === "CTT"));
  const five = await get<Decision[]>("/decisions?limit=5");
  check("GET /decisions?limit=5 -> 5, same head as the default", five.body.length === 5 && five.body.map((d) => d.decision_id).join() === decs.body.slice(0, 5).map((d) => d.decision_id).join());
  for (const q of ["0", "201", "abc", "1.5"]) {
    const r = await get(`/decisions?limit=${q}`);
    check(`GET /decisions?limit=${q} -> 400 invalid_limit`, r.status === 400 && r.body?.error === "invalid_limit");
  }

  // ---- xrpl accounts, subscribers, demo runs ----
  const acc = await get("/xrpl/accounts");
  check("GET /xrpl/accounts -> 200 registry (addresses only)", acc.status === 200 && /^r/.test(acc.body?.agent_account ?? "") && acc.body?.quorum === 3 && !JSON.stringify(acc.body).includes("seed"));
  const np5 = acc.body?.nonprofits?.np_5;
  check("GET /xrpl/accounts np_5 (golden demo wallet) carries its label, also in the name", !np5 || (typeof np5.label === "string" && np5.name.includes(np5.label) && np5.name.startsWith("Food Bank For New York City")), np5);
  const subs = await get("/subscribers", SUBSCRIBERS_TOKEN ? { "x-api-token": SUBSCRIBERS_TOKEN } : {});
  check(`GET /subscribers -> 200 array (Mongo "subscribers"; ${Array.isArray(subs.body) ? subs.body.length : "?"} rows, not printed)`, subs.status === 200 && Array.isArray(subs.body) && subs.body.every((s: Record<string, unknown>) => !("_id" in s) && /^\+1\d{10}$/.test(String(s.phone))));
  if (SUBSCRIBERS_TOKEN) {
    const noTok = await get("/subscribers");
    check("GET /subscribers without x-api-token -> 401 (SUBSCRIBERS_TOKEN set)", noTok.status === 401 && noTok.body?.error === "unauthorized");
  }
  const runs = await get("/demo/runs");
  check("GET /demo/runs -> 200 array", runs.status === 200 && Array.isArray(runs.body));
  const run404 = await get("/demo/runs/run_nope");
  check("GET /demo/runs/run_nope -> 404 run_not_found", run404.status === 404 && run404.body?.error === "run_not_found");

  // ---- guards (each is rejected: nothing is written) ----
  if (EVENTS_TOKEN) {
    const ev = await post("/events/payment", { decision_id: decs.body[0].decision_id });
    check("POST /events/payment without x-events-token -> 401 (EVENTS_TOKEN set)", ev.status === 401 && ev.body?.error === "unauthorized");
    const evBad = await post("/events/payment", { decision_id: decs.body[0].decision_id }, { "x-events-token": "wrong" });
    check("POST /events/payment with a wrong token -> 401", evBad.status === 401);
  }
  const ev404 = await post("/events/payment", { decision_id: "no_such_decision" }, EVENTS_TOKEN ? { "x-events-token": EVENTS_TOKEN } : {});
  check("POST /events/payment unknown decision -> 404 decision_not_found (nothing broadcast)", ev404.status === 404 && ev404.body?.error === "decision_not_found");
  const mism = await post("/events/payment", { decision_id: "a", decision: { ...decs.body[0] } }, EVENTS_TOKEN ? { "x-events-token": EVENTS_TOKEN } : {});
  check("POST /events/payment decision_id mismatch -> 400 decision_id_mismatch", mism.status === 400 && mism.body?.error === "decision_id_mismatch");
  if (!DEV_ROUTES) {
    const flip = await post("/dev/flip/site_fbnyc");
    check("POST /dev/flip in mongo mode -> 403 dev_route_disabled (DEV_ROUTES unset)", flip.status === 403 && flip.body?.error === "dev_route_disabled");
  }
  const unknown = await post("/demo/nope");
  check("POST /demo/nope -> 404 unknown_scenario with the mongo list (incl. golden, uncredentialed, escrow)", unknown.status === 404 && ["happy", "golden", "uncredentialed", "escrow", "escrow-release"].every((s) => unknown.body?.scenarios?.includes(s)));
  const noop = await post("/demo/escrow-release");
  check("POST /demo/escrow-release -> 202 no-op with a message (no run started)", noop.status === 202 && noop.body?.status === "noop" && noop.body?.run_id === null && noop.body?.decision === null && typeof noop.body?.message === "string");
  const proto: { name: string; status: number }[] = [];
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) proto.push({ name, status: (await post(`/demo/${name}`)).status });
  check("POST /demo/<Object.prototype name> -> 404 (own-property lookups only)", proto.every((x) => x.status === 404), proto);
  const evil = await post("/demo/escrow-release", undefined, { Origin: "http://evil.example" });
  check("POST /demo/* from a foreign browser origin -> 403 origin_not_allowed", evil.status === 403 && evil.body?.error === "origin_not_allowed", evil.body);
  const evilReset = await post("/dev/reset", undefined, { Origin: "http://evil.example" });
  check("POST /dev/reset from a foreign browser origin -> 403 origin_not_allowed (nothing reset)", evilReset.status === 403 && evilReset.body?.error === "origin_not_allowed", evilReset.body);
  const local = await post("/demo/escrow-release", undefined, { Origin: "http://localhost:3000" });
  check("POST /demo/* from http://localhost:3000 (the web app) -> allowed", local.status === 202 && local.body?.status === "noop", local.body);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.log(`FAIL smoke-mongo crashed -- ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
