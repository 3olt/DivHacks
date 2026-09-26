// Smoke test against a RUNNING api server.
//   API_URL=http://localhost:4000 npm run smoke -w api
// Prints PASS/FAIL per assertion and exits 1 on any failure. Calls POST /dev/reset at the start and end.
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { CHECK_NAMES, REFUSAL_CODES } from "../../shared/contracts";
import type { AgencyStats, Decision, LiveMessage, Site, Subscriber, Trail } from "../../shared/contracts";

const API = (process.env.API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const WS_URL = `${API.replace(/^http/, "ws")}/live`;

let passed = 0;
let failed = 0;
function check(name: string, ok: unknown, detail?: unknown): boolean {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail !== undefined ? ` -- ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
  return Boolean(ok);
}

interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}
async function call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(`${API}${path}`, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

// Independent re-implementation of the canonical-JSON decision hash (keys sorted, no whitespace).
function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}
// decision_hash covers ONLY the pre-signing fields (checks, outcome, signers, tx hash, ledger result are
// excluded: the tx carries dh in its memo, and the ledger proves those). Kept independent of shared/hash.ts.
const HASHED_FIELDS = ["decision_id", "invoice_id", "contract_id", "payee_ein", "amount", "currency", "agent_reasoning", "rule_version", "source_tag", "created_at"] as const;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hashOf = (d: Decision) => sha256(canonical(Object.fromEntries(HASHED_FIELDS.map((k) => [k, d[k]]))));
/** memo_hash = SHA-256 of the MemoData JSON string exactly as written on-ledger (key order inv, ctr, ein, dh, rv). */
const memoHashOf = (d: Decision) => sha256(JSON.stringify({ inv: d.invoice_id, ctr: d.contract_id, ein: d.payee_ein, dh: d.decision_hash, rv: d.rule_version }));

function haversine(a: [number, number], b: [number, number]): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(b[1] - a[1]) / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(r(b[0] - a[0]) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

const t = (s: string) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
const isSortedAsc = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);
const levelFor = (score: number) => (score >= 70 ? "red" : score >= 40 ? "yellow" : "green");

class LiveClient {
  readonly messages: LiveMessage[] = [];
  private listeners: (() => void)[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      try {
        this.messages.push(JSON.parse(String(data)) as LiveMessage);
      } catch {
        /* ignore */
      }
      for (const l of this.listeners) l();
    });
  }
  static connect(url: string): Promise<LiveClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new LiveClient(ws);
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
    });
  }
  /** Resolve with the index of the first message at or after `from` matching `pred`. */
  waitFor(pred: (m: LiveMessage) => boolean, from = 0, timeoutMs = 4000): Promise<number> {
    return new Promise((resolve) => {
      const scan = () => {
        for (let i = from; i < this.messages.length; i++) if (pred(this.messages[i])) return i;
        return -1;
      };
      const found = scan();
      if (found >= 0) return resolve(found);
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== onMsg);
        resolve(-1);
      }, timeoutMs);
      const onMsg = () => {
        const i = scan();
        if (i >= 0) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((l) => l !== onMsg);
          resolve(i);
        }
      };
      this.listeners.push(onMsg);
    });
  }
  close() {
    this.ws.close();
  }
}

async function main() {
  console.log(`Smoke test against ${API}\n`);

  // ---- health + reset ----
  const health = await call("GET", "/health");
  check("GET /health 200 ok:true mode:fixtures", health.status === 200 && health.body?.ok === true && health.body?.mode === "fixtures" && typeof health.body?.time === "string" && typeof health.body?.version === "string", health.body);
  const reset0 = await call("POST", "/dev/reset");
  check("POST /dev/reset (start) -> {ok:true}", reset0.status === 200 && reset0.body?.ok === true, reset0.body);

  // ---- CORS ----
  const pre = await fetch(`${API}/subscribers/%2B12125550142`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "content-type" },
  });
  check("CORS preflight allows any origin + DELETE", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "http://localhost:3000" && (pre.headers.get("access-control-allow-methods") ?? "").includes("DELETE"), {
    status: pre.status,
    origin: pre.headers.get("access-control-allow-origin"),
    methods: pre.headers.get("access-control-allow-methods"),
  });
  const corsGet = await fetch(`${API}/sites`, { headers: { Origin: "https://example.test" } });
  check("CORS header on GET", corsGet.headers.get("access-control-allow-origin") === "https://example.test");

  // ---- /sites ----
  const sitesRes = await call<Site[]>("GET", "/sites");
  const sites = sitesRes.body;
  check("GET /sites 200 bare array of 15", sitesRes.status === 200 && Array.isArray(sites) && sites.length === 15, sitesRes.status);
  const ids = sites.map((s) => s.id);
  check("site ids site_001..site_015", ids.join() === Array.from({ length: 15 }, (_, i) => `site_${String(i + 1).padStart(3, "0")}`).join(), ids);
  const shapeOk = sites.every(
    (s) =>
      s.location?.type === "Point" &&
      s.location.coordinates.length === 2 &&
      s.location.coordinates[0] > -74.26 && s.location.coordinates[0] < -73.7 &&
      s.location.coordinates[1] > 40.49 && s.location.coordinates[1] < 40.92 &&
      /^\d{5}$/.test(s.zip) &&
      typeof s.address === "string" &&
      typeof s.nonprofit_ein === "string" &&
      Array.isArray(s.contract_ids) && s.contract_ids.length > 0 &&
      s.is_demo_data === true,
  );
  check("every site: NYC [lng,lat], 5-digit zip, address, contract_ids, is_demo_data", shapeOk);
  const riskOk = sites.every(
    (s) =>
      levelFor(s.risk.score) === s.risk.level &&
      s.risk.reasons.length > 0 &&
      s.risk.reasons.every((r) => /\d/.test(r)) &&
      s.risk.summary.split(/\s+/).length <= 25 &&
      !Number.isNaN(Date.parse(s.risk.computed_at)),
  );
  check("every risk: level matches score band, reasons carry numbers, summary <= 25 words", riskOk);
  const levels = sites.reduce<Record<string, number>>((a, s) => ({ ...a, [s.risk.level]: (a[s.risk.level] ?? 0) + 1 }), {});
  check("risk mix 5 green / 6 yellow / 4 red", levels.green === 5 && levels.yellow === 6 && levels.red === 4, levels);
  const boroughs = sites.reduce<Record<string, number>>((a, s) => ({ ...a, [s.borough]: (a[s.borough] ?? 0) + 1 }), {});
  check("all 5 boroughs, >= 2 sites each", ["Bronx", "Manhattan", "Brooklyn", "Queens", "Staten Island"].every((b) => (boroughs[b] ?? 0) >= 2), boroughs);
  const agencyForType: Record<string, string[]> = { food_pantry: ["HRA"], grocery_giveaway: ["HRA"], shelter: ["DHS"], youth_program: ["DYCD"], event: ["HRA", "DHS", "DYCD"] };
  check("agency matches service type", sites.every((s) => agencyForType[s.type]?.includes(s.agency_code)));
  const eventsOk = sites.every(
    (s) =>
      s.events.length >= 1 && s.events.length <= 2 &&
      s.events.every((e) => e.is_demo_data === true && e.starts_at.endsWith("-04:00") && e.starts_at >= "2026-09-27" && e.starts_at < "2026-10-16"),
  );
  check("1-2 demo events per site, 2026-09-27..2026-10-15, -04:00", eventsOk);
  const golden = sites.find((s) => s.id === "site_001")!;
  check("golden site_001: yellow HRA food pantry in the Bronx, zip 10453", golden.risk.level === "yellow" && golden.agency_code === "HRA" && golden.type === "food_pantry" && golden.borough === "Bronx" && golden.zip === "10453", golden.risk);

  const fp = await call<Site[]>("GET", "/sites?type=food_pantry");
  check("?type=food_pantry -> only food pantries (5)", fp.status === 200 && fp.body.length === 5 && fp.body.every((s) => s.type === "food_pantry"), fp.body.length);
  const multi = await call<Site[]>("GET", "/sites?type=shelter,youth_program");
  check("?type=shelter,youth_program -> 6", multi.status === 200 && multi.body.length === 6 && multi.body.every((s) => s.type === "shelter" || s.type === "youth_program"), multi.body.length);
  const badType = await call("GET", "/sites?type=casino");
  check("?type=casino -> 400 invalid_type", badType.status === 400 && badType.body?.error === "invalid_type", badType.body);

  const bbox = [-73.95, 40.8, -73.85, 40.9]; // South/West Bronx + upper Manhattan
  const inBox = await call<Site[]>("GET", `/sites?bbox=${bbox.join(",")}`);
  const expectedInBox = sites.filter(({ location: { coordinates: [x, y] } }) => x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3]).map((s) => s.id);
  check("?bbox filters to the box", inBox.status === 200 && inBox.body.map((s) => s.id).join() === expectedInBox.join() && expectedInBox.includes("site_001"), { got: inBox.body.map?.((s) => s.id), expectedInBox });
  for (const bad of ["1,2,3", "a,b,c,d", "-73.8,40.8,-73.9,40.9", "-200,40,-73,41"]) {
    const r = await call("GET", `/sites?bbox=${encodeURIComponent(bad)}`);
    check(`?bbox=${bad} -> 400 invalid_bbox`, r.status === 400 && r.body?.error === "invalid_bbox", r.body);
  }

  const center: [number, number] = [-73.9095, 40.8538];
  const near = await call<Site[]>("GET", `/sites?near=${center.join(",")}&radius_m=3000`);
  const nearDists = near.body.map((s) => haversine(center, s.location.coordinates));
  check("?near=site_001&radius_m=3000 -> site_001 first, all within 3 km, sorted nearest first", near.status === 200 && near.body[0]?.id === "site_001" && nearDists.every((d) => d <= 3000) && isSortedAsc(nearDists), near.body.map?.((s) => s.id));
  const nearDefault = await call<Site[]>("GET", `/sites?near=${center.join(",")}`);
  check("?near default radius 2000 m", nearDefault.status === 200 && nearDefault.body.every((s) => haversine(center, s.location.coordinates) <= 2000) && nearDefault.body.length >= 1);
  const nearAll = await call<Site[]>("GET", `/sites?type=food_pantry&near=${center.join(",")}&radius_m=50000`);
  const allDists = nearAll.body.map((s) => haversine(center, s.location.coordinates));
  check("?type + near combine (AND) and sort by distance", nearAll.status === 200 && nearAll.body.length === 5 && nearAll.body.every((s) => s.type === "food_pantry") && isSortedAsc(allDists));
  for (const [q, code] of [
    ["near=abc", "invalid_near"],
    ["near=-73.91", "invalid_near"],
    ["near=-200,40.85", "invalid_near"],
    [`near=${center.join(",")}&radius_m=60000`, "invalid_radius"],
    [`near=${center.join(",")}&radius_m=-5`, "invalid_radius"],
  ] as const) {
    const r = await call("GET", `/sites?${q}`);
    check(`?${q} -> 400 ${code}`, r.status === 400 && r.body?.error === code, r.body);
  }

  const one = await call<Site>("GET", "/sites/site_001");
  check("GET /sites/site_001 -> full site", one.status === 200 && one.body.id === "site_001" && one.body.risk?.level === "yellow");
  const missing = await call("GET", "/sites/site_999");
  check("GET /sites/site_999 -> 404 site_not_found", missing.status === 404 && missing.body?.error === "site_not_found", missing.body);

  // ---- trails ----
  let trailsOk = true;
  for (const s of sites) {
    const tr = await call<Trail>("GET", `/sites/${s.id}/trail`);
    const b = tr.body;
    const ok =
      tr.status === 200 &&
      b.site_id === s.id &&
      b.agency?.code === s.agency_code &&
      b.nonprofit?.ein === s.nonprofit_ein &&
      b.contracts.map((c) => c.contract_id).join() === s.contract_ids.join() &&
      isSortedAsc(b.payments.map((p) => t(p.date))) &&
      isSortedAsc(b.decisions.map((d) => -t(d.created_at))) &&
      b.payments.every((p) => p.is_demo_data === true && (p.source === "checkbook" ? p.currency === "USD" : p.currency === "RLUSD"));
    if (!ok) {
      trailsOk = false;
      check(`trail ${s.id}`, false, { status: tr.status });
    }
  }
  check("every site has a consistent trail (agency, nonprofit, contracts, payments oldest-first, decisions newest-first)", trailsOk);
  const gt = (await call<Trail>("GET", "/sites/site_001/trail")).body;
  check(
    "golden trail is rich: >= 2 contracts, checkbook + xrpl payments, >= 4 decisions",
    gt.contracts.length >= 2 && gt.payments.some((p) => p.source === "checkbook") && gt.payments.some((p) => p.source === "xrpl") && gt.decisions.length >= 4,
    { contracts: gt.contracts.length, payments: gt.payments.length, decisions: gt.decisions.length },
  );
  const xrplReleased = gt.payments.find((p) => p.source === "xrpl" && p.status === "released");
  check(
    "xrpl released payment has placeholder tx hash, explorer_url, memo_hash",
    !!xrplReleased && /^00000000FA15E[0-9A-F]{51}$/.test(xrplReleased.xrpl_tx_hash ?? "") && xrplReleased.explorer_url === `https://testnet.xrpl.org/transactions/${xrplReleased.xrpl_tx_hash}` && /^[0-9a-f]{64}$/.test(xrplReleased.memo_hash ?? ""),
    xrplReleased,
  );
  const memoDecision = gt.decisions.find((d) => `xrpl_${d.decision_id}` === xrplReleased?.payment_id);
  check("xrpl payment memo_hash = sha256 of MemoData JSON {inv,ctr,ein,dh,rv} of its decision", !!memoDecision && xrplReleased?.memo_hash === memoHashOf(memoDecision), xrplReleased?.payment_id);
  const tr404 = await call("GET", "/sites/nope/trail");
  check("GET /sites/nope/trail -> 404", tr404.status === 404 && tr404.body?.error === "site_not_found");

  // ---- agencies ----
  for (const code of ["HRA", "dhs", "Dycd"]) {
    const a = await call<AgencyStats>("GET", `/agencies/${code}/stats`);
    check(`GET /agencies/${code}/stats (case-insensitive)`, a.status === 200 && a.body.code === code.toUpperCase() && a.body.is_demo_data === true && typeof a.body.source_url === "string", a.body);
  }
  const a404 = await call("GET", "/agencies/NYPD/stats");
  check("GET /agencies/NYPD/stats -> 404 agency_not_found", a404.status === 404 && a404.body?.error === "agency_not_found");

  // ---- /xrpl/accounts (public Testnet registry for the open-data page) ----
  const isRAddress = (a: unknown) => typeof a === "string" && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a);
  const reg = await call("GET", "/xrpl/accounts");
  check(
    "GET /xrpl/accounts -> 200 testnet registry: agent_account, treasury, issuer, attacker are r-addresses",
    reg.status === 200 && reg.body?.network === "testnet" && ["agent_account", "city_treasury", "city_issuer", "attacker"].every((k) => isRAddress(reg.body[k])),
    reg.status === 200 ? Object.keys(reg.body ?? {}) : reg.body,
  );
  check(
    "GET /xrpl/accounts signers agent/cosigner/officer with weights 1/2/1, quorum 3",
    ["agent", "cosigner", "officer"].every((r) => isRAddress(reg.body?.signers?.[r]?.address)) &&
      reg.body?.signers?.agent?.weight === 1 && reg.body?.signers?.cosigner?.weight === 2 && reg.body?.signers?.officer?.weight === 1 && reg.body?.quorum === 3,
    reg.body?.signers,
  );
  check(
    "GET /xrpl/accounts nonprofits np_1..np_4 map to EINs 00-0000001..4",
    [1, 2, 3, 4].every((i) => isRAddress(reg.body?.nonprofits?.[`np_${i}`]?.address) && reg.body.nonprofits[`np_${i}`].ein === `00-000000${i}`),
    reg.body?.nonprofits,
  );
  check(
    "GET /xrpl/accounts RLUSD = 40-hex currency + r-address issuer, source_tag 26092026",
    /^[0-9A-F]{40}$/i.test(reg.body?.rlusd?.currency ?? "") && isRAddress(reg.body?.rlusd?.issuer) && reg.body?.source_tag === 26092026,
    { rlusd: reg.body?.rlusd, source_tag: reg.body?.source_tag },
  );
  check("GET /xrpl/accounts serves no secret-looking field (seed/secret/private)", !/seed|secret|private/i.test(JSON.stringify(reg.body ?? {})));

  // ---- decisions ----
  const decRes = await call<Decision[]>("GET", "/decisions");
  const decs = decRes.body;
  check("GET /decisions -> >= 7, newest first", decRes.status === 200 && decs.length >= 7 && isSortedAsc(decs.map((d) => -t(d.created_at))), decs.length);
  check("every decision has the 8 checks in CHECK_NAMES order", decs.every((d) => d.checks.map((c) => c.name).join() === CHECK_NAMES.join()));
  check("every refusal code is a REFUSAL_CODE", decs.every((d) => d.refusal_reasons.every((r) => (REFUSAL_CODES as readonly string[]).includes(r))));
  check("released decisions: no refusals, all checks passed, tesSUCCESS, placeholder hash", decs.filter((d) => d.outcome === "released").every((d) => d.refusal_reasons.length === 0 && d.checks.every((c) => c.passed) && d.ledger_result === "tesSUCCESS" && d.enforced_by === null && d.xrpl_tx_hash?.startsWith("00000000FA15E")));
  check("decision_hash = sha256(canonical JSON of the pre-signing fields only)",decs.every((d) => hashOf(d) === d.decision_hash), decs.filter((d) => hashOf(d) !== d.decision_hash).map((d) => d.decision_id));
  check("signers are role names", decs.every((d) => d.signers.every((s) => ["agent", "cosigner", "officer"].includes(s))));
  check("ledger-enforced attacker tx: tefBAD_QUORUM, agent only, no hash", decs.some((d) => d.enforced_by === "ledger" && d.ledger_result === "tefBAD_QUORUM" && d.xrpl_tx_hash === null && d.signers.join() === "agent"));
  check("over-limit release signed by agent+cosigner+officer", decs.some((d) => d.outcome === "released" && d.signers.join() === "agent,cosigner,officer"));
  for (const code of ["suspicious_instructions_in_invoice", "invoice_already_paid", "over_auto_limit_needs_officer", "payee_change_on_hold"]) {
    check(`fixture decisions include ${code}`, decs.some((d) => d.refusal_reasons.includes(code)));
  }
  const lim = await call<Decision[]>("GET", "/decisions?limit=2");
  check("?limit=2 -> 2", lim.status === 200 && lim.body.length === 2 && lim.body[0].decision_id === decs[0].decision_id);
  for (const bad of ["0", "abc", "201", "-1", "2.5"]) {
    const r = await call("GET", `/decisions?limit=${bad}`);
    check(`?limit=${bad} -> 400 invalid_limit`, r.status === 400 && r.body?.error === "invalid_limit", r.body);
  }

  // ---- subscribers ----
  const created = await call<Subscriber>("POST", "/subscribers", { phone: "(212) 555-0199", zip: "10453", site_ids: ["site_001"], interests: ["food_pantry"] });
  check("POST /subscribers -> 201, phone normalized to E.164", created.status === 201 && created.body.phone === "+12125550199" && created.body.channel === "web" && created.body.site_ids.join() === "site_001", created.body);
  const updated = await call<Subscriber>("POST", "/subscribers", { phone: "+1 212 555 0199", zip: "10453", site_ids: ["site_004"], channel: "imessage" });
  check("POST same phone -> 200 upsert (site_ids merged, channel updated)", updated.status === 200 && updated.body.site_ids.join() === "site_001,site_004" && updated.body.channel === "imessage", updated.body);
  const legacy = await call<Subscriber>("POST", "/subscribers", { phone: "2125550198", site_id: "site_002" });
  check("POST {phone, site_id} (legacy form) -> 201, zip defaults to site zip", legacy.status === 201 && legacy.body.zip === "10454" && legacy.body.site_ids.join() === "site_002", legacy.body);
  // Existing subscriber (seed +12125550142, zip 10453) subscribes to a Brooklyn site without sending a zip:
  // the stored home zip must be kept, not replaced by the site's zip.
  const keepZip = await call<Subscriber>("POST", "/subscribers", { phone: "2125550142", site_id: "site_007" });
  check("POST {phone, site_id} for an existing subscriber keeps their zip, merges the site", keepZip.status === 200 && keepZip.body.zip === "10453" && keepZip.body.site_ids.join() === "site_001,site_007", keepZip.body);
  for (const [body, code] of [
    [{ phone: "555-0199", zip: "10453" }, "invalid_phone"],
    [{ phone: "+44 20 7946 0958", zip: "10453" }, "invalid_phone"],
    [{ phone: "2125550199", zip: "1045" }, "invalid_zip"],
    [{ phone: "2125550197" }, "invalid_zip"], // new phone, no zip, no site (an existing phone would keep its zip)
    [{ phone: "2125550199", zip: "10453", site_ids: ["site_999"] }, "unknown_site_ids"],
    [{ phone: "2125550199", zip: "10453", channel: "fax" }, "invalid_channel"],
    [{ phone: "2125550199", zip: "10453", interests: ["casino"] }, "invalid_interests"],
  ] as const) {
    const r = await call("POST", "/subscribers", body);
    check(`POST /subscribers ${JSON.stringify(body)} -> 400 ${code}`, r.status === 400 && r.body?.error === code, r.body);
  }
  const bySite = await call<Subscriber[]>("GET", "/subscribers?site_id=site_001");
  check("GET /subscribers?site_id=site_001 includes the new subscriber", bySite.status === 200 && bySite.body.some((s) => s.phone === "+12125550199") && bySite.body.every((s) => s.site_ids.includes("site_001")));
  const all = await call<Subscriber[]>("GET", "/subscribers");
  check("GET /subscribers -> all (2 seeds + 2 new)", all.status === 200 && all.body.length === 4, all.body.length);
  const del = await call("DELETE", "/subscribers/%2B12125550199");
  check("DELETE /subscribers/%2B12125550199 -> 204", del.status === 204, del.status);
  const del10 = await call("DELETE", "/subscribers/2125550198");
  check("DELETE /subscribers/2125550198 (10-digit) -> 204", del10.status === 204, del10.status);
  const delAgain = await call("DELETE", "/subscribers/%2B12125550199");
  check("DELETE again -> 404 subscriber_not_found", delAgain.status === 404 && delAgain.body?.error === "subscriber_not_found", delAgain.body);

  // ---- 404 + bad JSON ----
  const nf = await call("GET", "/definitely/not/here");
  check("unknown route -> 404 JSON {error:not_found}", nf.status === 404 && nf.body?.error === "not_found", nf.body);
  const badJson = await fetch(`${API}/subscribers`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
  check("malformed JSON -> 400 invalid_json", badJson.status === 400 && (await badJson.json()).error === "invalid_json");
  const liveHttp = await call("GET", "/live");
  check("plain HTTP GET /live -> 426", liveHttp.status === 426, liveHttp.status);

  // ---- WebSocket /live ----
  const live = await LiveClient.connect(WS_URL);
  const helloIdx = await live.waitFor((m) => m.type === "hello");
  const hello = live.messages[helloIdx];
  check("WS /live sends hello {mode:fixtures, server_time}", helloIdx >= 0 && hello?.type === "hello" && hello.mode === "fixtures" && !Number.isNaN(Date.parse(hello.server_time)), hello);

  // dev flip (default: site_003 is green -> yellow)
  let from = live.messages.length;
  const flip = await call("POST", "/dev/flip/site_003");
  const flipIdx = await live.waitFor((m) => m.type === "site_updated" && m.site_id === "site_003", from);
  const flipMsg = live.messages[flipIdx];
  check("POST /dev/flip/site_003 -> 200 {site_id, risk} default green->yellow", flip.status === 200 && flip.body?.site_id === "site_003" && flip.body?.risk?.level === "yellow" && flip.body.risk.reasons.some((r: string) => r.includes("(dev flip)")) && flip.body.risk.reasons.every((r: string) => /\d/.test(r)), flip.body);
  check("WS got site_updated for site_003 matching the response", flipIdx >= 0 && flipMsg?.type === "site_updated" && flipMsg.risk.level === flip.body?.risk?.level);
  const flipRed = await call("POST", "/dev/flip/site_003?level=red");
  check("POST /dev/flip/site_003?level=red -> red, score >= 70", flipRed.status === 200 && flipRed.body?.risk?.level === "red" && flipRed.body.risk.score >= 70, flipRed.body);
  const flipBody = await call("POST", "/dev/flip/site_003", { level: "green" });
  check("POST /dev/flip/site_003 body {level:green} -> green, score < 40", flipBody.status === 200 && flipBody.body?.risk?.level === "green" && flipBody.body.risk.score < 40, flipBody.body);
  const flipBad = await call("POST", "/dev/flip/site_003", { level: "purple" });
  check("POST /dev/flip level=purple -> 400 invalid_level", flipBad.status === 400 && flipBad.body?.error === "invalid_level");
  const flip404 = await call("POST", "/dev/flip/site_999");
  check("POST /dev/flip/site_999 -> 404", flip404.status === 404);

  // events/payment for a released fixture decision -> site_updated THEN decision
  from = live.messages.length;
  const ev = await call("POST", "/events/payment", { decision_id: "fx_dec_001" });
  check(
    "POST /events/payment released -> 200 site_001 green, broadcast [site_updated, decision]",
    ev.status === 200 && ev.body?.site_id === "site_001" && ev.body?.risk?.level === "green" && ev.body.risk.score < 40 && JSON.stringify(ev.body.broadcast) === JSON.stringify(["site_updated", "decision"]) && ev.body.risk.reasons[0].startsWith("RLUSD 12.50 released on XRPL"),
    ev.body,
  );
  const suIdx = await live.waitFor((m) => m.type === "site_updated" && m.site_id === "site_001", from);
  const dIdx = await live.waitFor((m) => m.type === "decision" && m.decision.decision_id === "fx_dec_001", from);
  check("WS got site_updated(site_001 green) then decision(fx_dec_001)", suIdx >= 0 && dIdx > suIdx && (live.messages[suIdx] as any).risk.level === "green", { suIdx, dIdx });
  const g2 = await call<Site>("GET", "/sites/site_001");
  check("GET /sites/site_001 now green", g2.body.risk.level === "green");

  from = live.messages.length;
  const evRefused = await call("POST", "/events/payment", { decision_id: "fx_dec_003" });
  const refIdx = await live.waitFor((m) => m.type === "decision" && m.decision.decision_id === "fx_dec_003", from);
  check("POST /events/payment refused -> broadcast [decision] only", evRefused.status === 200 && JSON.stringify(evRefused.body?.broadcast) === JSON.stringify(["decision"]) && refIdx >= 0, evRefused.body);
  check("  ...and no site_updated was sent for it", live.messages.slice(from).every((m) => m.type !== "site_updated"));
  // A release that leaves the site yellow (site_012, fx_dec_007) must not claim "running late" and "now current" at once.
  const evYellow = await call("POST", "/events/payment", { decision_id: "fx_dec_007" });
  check(
    "POST /events/payment released but still yellow -> summary = payment + biggest remaining driver",
    evYellow.status === 200 && evYellow.body?.site_id === "site_012" && evYellow.body.risk.level === "yellow" && evYellow.body.risk.summary.startsWith("Payments running late: RLUSD 32 released on XRPL") && !evYellow.body.risk.summary.includes("now current"),
    evYellow.body?.risk,
  );
  const evMissing = await call("POST", "/events/payment", {});
  check("POST /events/payment {} -> 400 missing_decision_id", evMissing.status === 400 && evMissing.body?.error === "missing_decision_id", evMissing.body);
  const evUnknown = await call("POST", "/events/payment", { decision_id: "nope" });
  check("POST /events/payment unknown -> 404 decision_not_found", evUnknown.status === 404 && evUnknown.body?.error === "decision_not_found", evUnknown.body);

  // push a full decision (what the Phase 5 xrpl service does)
  const pushed: Decision = { ...decs.find((d) => d.decision_id === "fx_dec_002")!, decision_id: "smoke_pushed_001", invoice_id: "INV-SMOKE-1", created_at: new Date().toISOString() };
  pushed.decision_hash = hashOf(pushed);
  from = live.messages.length;
  const evPush = await call("POST", "/events/payment", { decision_id: pushed.decision_id, decision: pushed });
  const pushIdx = await live.waitFor((m) => m.type === "decision" && m.decision.decision_id === "smoke_pushed_001", from);
  check("POST /events/payment with full decision -> stored, site_009 updated, broadcast", evPush.status === 200 && evPush.body?.site_id === "site_009" && pushIdx >= 0, evPush.body);
  const afterPush = await call<Decision[]>("GET", "/decisions?limit=200");
  check("pushed decision appears in GET /decisions", afterPush.body.some((d) => d.decision_id === "smoke_pushed_001"));
  const badPush = await call("POST", "/events/payment", { decision: { decision_id: "x" } });
  check("POST /events/payment with malformed decision -> 400 invalid_decision", badPush.status === 400 && badPush.body?.error === "invalid_decision", badPush.body);

  // demo scenarios
  from = live.messages.length;
  const inj = await call("POST", "/demo/injection");
  const injIdx = await live.waitFor((m) => m.type === "decision" && m.decision.decision_id === inj.body?.decision?.decision_id, from);
  check(
    "POST /demo/injection -> 202 refused suspicious_instructions_in_invoice (fx_demo_, fixture-0, [fixture])",
    inj.status === 202 && inj.body?.scenario === "injection" && inj.body?.mode === "fixtures" && inj.body.decision.outcome === "refused" && inj.body.decision.refusal_reasons.includes("suspicious_instructions_in_invoice") && inj.body.decision.decision_id.startsWith("fx_demo_") && inj.body.decision.rule_version === "fixture-0" && inj.body.decision.agent_reasoning.startsWith("[fixture] ") && inj.body.site_updated === undefined,
    inj.body,
  );
  check("WS got the injection decision", injIdx >= 0);

  // Reset first (golden back to yellow). The reset broadcasts site_updated for changed sites; wait for it.
  const beforeReset = live.messages.length;
  await call("POST", "/dev/reset");
  const resetMsg = await live.waitFor((m) => m.type === "site_updated" && m.site_id === "site_001" && m.risk.level === "yellow", beforeReset);
  check("POST /dev/reset broadcasts site_updated for sites it changed", resetMsg >= 0);
  from = live.messages.length;
  const happy = await call("POST", "/demo/happy");
  const hSu = await live.waitFor((m) => m.type === "site_updated" && m.site_id === "site_001" && m.risk.level === "green", from);
  const hDec = await live.waitFor((m) => m.type === "decision" && m.decision.decision_id === happy.body?.decision?.decision_id, from);
  check("POST /demo/happy -> 202 released + site_updated golden green", happy.status === 202 && happy.body?.decision?.outcome === "released" && happy.body?.site_updated?.site_id === "site_001" && happy.body.site_updated.risk.level === "green", happy.body?.site_updated);
  check("WS got site_updated before decision for happy", hSu >= 0 && hDec > hSu, { hSu, hDec });
  check("happy decision hash verifies", happy.body?.decision && hashOf(happy.body.decision) === happy.body.decision.decision_hash);
  const trailAfter = (await call<Trail>("GET", "/sites/site_001/trail")).body;
  check("golden trail now shows the demo payment + decision", trailAfter.payments.some((p) => p.invoice_id === happy.body?.decision?.invoice_id) && trailAfter.decisions[0]?.decision_id === happy.body?.decision?.decision_id);

  // Double-click: two happy runs at once (usually within the same second). The later one must see the earlier
  // one in its 24h total, and GET /decisions must still be newest first.
  const [h1, h2] = await Promise.all([call("POST", "/demo/happy"), call("POST", "/demo/happy")]);
  const [early, late] = [h1.body.decision, h2.body.decision].sort((a: Decision, b: Decision) => a.decision_id.localeCompare(b.decision_id));
  const agentTotal = (d: Decision) => Number(/Agent 24h total ([\d,.]+)/.exec(d.checks.find((c) => c.name === "within_daily_caps")!.detail)?.[1].replace(/,/g, "") ?? NaN);
  check("rapid happy x2: later decision's 24h total includes the earlier one", agentTotal(late) === agentTotal(early) + 12.5, { early: agentTotal(early), late: agentTotal(late) });
  const newest = (await call<Decision[]>("GET", "/decisions?limit=2")).body.map((d) => d.decision_id);
  check("rapid happy x2: GET /decisions is newest first even within one second", newest.join() === [late.decision_id, early.decision_id].join(), newest);

  const expected: Record<string, (d: Decision) => boolean> = {
    duplicate: (d) => d.refusal_reasons.includes("invoice_already_paid"),
    "over-contract": (d) => d.refusal_reasons.includes("contract_amount_exceeded"),
    "address-swap": (d) => d.enforced_by === "hold" && d.refusal_reasons.includes("payee_change_on_hold"),
    "over-limit": (d) => d.outcome === "pending_approval" && d.refusal_reasons.includes("over_auto_limit_needs_officer"),
    "kill-switch": (d) => d.enforced_by === "ledger" && d.refusal_reasons.includes("ledger_rejected"),
  };
  for (const [scenario, ok] of Object.entries(expected)) {
    const r = await call("POST", `/demo/${scenario}`);
    check(`POST /demo/${scenario} -> 202 with expected decision`, r.status === 202 && r.body?.scenario === scenario && ok(r.body.decision) && hashOf(r.body.decision) === r.body.decision.decision_hash, r.body?.decision?.refusal_reasons);
  }
  const unknown = await call("POST", "/demo/nope");
  check("POST /demo/nope -> 404 unknown_scenario with list", unknown.status === 404 && unknown.body?.error === "unknown_scenario" && Array.isArray(unknown.body.scenarios) && unknown.body.scenarios.length === 7, unknown.body);

  // ---- reset ----
  const reset = await call("POST", "/dev/reset");
  const afterReset = await call<Site>("GET", "/sites/site_001");
  const decAfterReset = await call<Decision[]>("GET", "/decisions?limit=200");
  const subsAfterReset = await call<Subscriber[]>("GET", "/subscribers");
  check(
    "POST /dev/reset restores sites, decisions, subscribers",
    reset.status === 200 && reset.body?.ok === true && afterReset.body.risk.level === "yellow" && decAfterReset.body.length === decs.length && subsAfterReset.body.length === 2,
    { golden: afterReset.body.risk.level, decisions: decAfterReset.body.length, subs: subsAfterReset.body.length },
  );

  live.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.log(`FAIL smoke crashed -- ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
