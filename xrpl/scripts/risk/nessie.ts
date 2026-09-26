// Phase 0 risk check N1: is Capital One's Nessie API reachable, and does its published OpenAPI spec
// still have the endpoints Phase 3 payee verification needs?
// Re-runnable: `cd xrpl && npx tsx scripts/risk/nessie.ts [--write-smoke]`
//
// Default run is read-only:
//   * reachability of http:// and https:// api.nessieisreal.com with an invalid key / no key
//   * downloads https://nessieisreal.com/nessie-openapi-spec.yaml (the file the docs page loads) and
//     checks the Phase 3 paths, methods and required body fields are still there
//   * with NESSIE_API_KEY (repo-root .env): GET /customers, GET /accounts, GET /accounts/{id}/deposits
// --write-smoke (only with a key; opt-in, never run by default) creates a throwaway customer
//   "DivHacks SmokeTest-<ts>" at a public address, one Checking account and one micro-deposit, prints
//   exactly what POST returns (the spec only documents a plain string such as "Customer created"),
//   then deletes the deposit and the account. The spec has no DELETE for customers, so the customer stays.
// The key is never printed (URLs are logged with key=***). Findings: scripts/risk/README-services.md.
import { loadEnv } from "../../src/env";

loadEnv();

const BASE = (process.env.NESSIE_BASE_URL ?? "https://api.nessieisreal.com").replace(/\/+$/, "");
const HTTP_BASE = "http://api.nessieisreal.com"; // what context.md / the spec prompt name; probed only
const SPEC_URL = "https://nessieisreal.com/nessie-openapi-spec.yaml";
const KEY = (process.env.NESSIE_API_KEY ?? "").trim();
const TIMEOUT_MS = 30_000;
const WRITE_SMOKE = process.argv.includes("--write-smoke");

type Status = "PASS" | "FAIL" | "PARTIAL" | "BLOCKED" | "INFO";
interface CheckResult { id: string; status: Status; notes: string; evidence: Record<string, unknown> }
const results: CheckResult[] = [];

function redact(s: string): string {
  let out = s.replace(/([?&]key=)[^&\s"]+/g, "$1***");
  if (KEY) out = out.split(KEY).join("***");
  return out;
}
function record(id: string, status: Status, notes: string, evidence: Record<string, unknown> = {}) {
  const ev = Object.fromEntries(Object.entries(evidence).filter(([, v]) => v !== undefined));
  results.push({ id, status, notes, evidence: ev });
  console.log(`\n[${status}] ${id}: ${redact(notes)}`);
  for (const [k, v] of Object.entries(ev)) console.log(`   ${k}: ${redact(typeof v === "string" ? v : String(JSON.stringify(v)))}`);
}
const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}...(${s.length} chars)` : s);
const errMsg = (e: unknown) => {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  return [err?.message, err?.cause?.code, err?.cause?.message].filter(Boolean).join(" | ");
};

interface HttpResult { status: number; ms: number; text: string; json: unknown; url: string }
async function http(method: "GET" | "POST" | "DELETE", url: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<HttpResult> {
  const t0 = performance.now();
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ms: Math.round(performance.now() - t0), text, json, url: redact(url) };
}
const withKey = (path: string, key: string) => `${BASE}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;

// ---- N1-reach -----------------------------------------------------------------------------------
async function reach() {
  // 1. Plain HTTP (port 80), as written in context.md.
  try {
    const r = await http("GET", `${HTTP_BASE}/atms?key=invalid`, undefined, 12_000);
    record("N1-reach-http", "INFO", `http:// answered HTTP ${r.status}`, { url: r.url, status: r.status, latency_ms: r.ms, body: short(r.text, 120) });
  } catch (e) {
    record("N1-reach-http", "INFO", "http:// (port 80) is not reachable; use https://", { url: `${HTTP_BASE}/atms?key=***`, error: errMsg(e) });
  }

  // 2. HTTPS probes. /atms and /branches are public reference data; the others show how auth behaves.
  const probes: { label: string; url: string }[] = [
    { label: "atms (public data), invalid key", url: withKey("/atms", "invalid") },
    { label: "customers, invalid key", url: withKey("/customers", "invalid") },
    { label: "accounts, invalid key", url: withKey("/accounts", "invalid") },
    { label: "customers, no key param", url: `${BASE}/customers` },
    { label: "customer by unknown id, invalid key", url: withKey("/customers/000000000000000000000000", "invalid") },
    { label: "undocumented route", url: `${BASE}/documentation` },
  ];
  const ev: Record<string, unknown> = {};
  let reachable = false;
  for (const p of probes) {
    try {
      const r = await http("GET", p.url);
      reachable ||= r.status > 0;
      const summary = Array.isArray(r.json) ? `JSON array, ${r.json.length} items` : short(r.text.trim(), 160);
      ev[p.label] = `GET ${r.url} -> HTTP ${r.status} in ${r.ms} ms: ${summary}`;
    } catch (e) {
      ev[p.label] = `GET ${redact(p.url)} -> error ${errMsg(e)}`;
    }
  }
  record("N1-reach-https", reachable ? "PASS" : "FAIL",
    reachable ? `${BASE} answers over HTTPS (note: an invalid key is NOT rejected on GET; it returns 200 with an empty list)` : `${BASE} did not answer`, ev);
}

// ---- N1-spec ------------------------------------------------------------------------------------
function pathBlock(spec: string, p: string): string | null {
  const start = spec.indexOf(`\n  ${p}:\n`);
  if (start < 0) return null;
  const rest = spec.slice(start + 1);
  const end = rest.slice(1).search(/\n(?:  \/|\S)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}
function methodsOf(block: string | null): string[] {
  return block ? [...block.matchAll(/\n    (get|post|put|delete|patch):/g)].map((m) => m[1].toUpperCase()) : [];
}
function schemaBlock(spec: string, name: string): string | null {
  const start = spec.indexOf(`\n    ${name}:\n`);
  if (start < 0) return null;
  const rest = spec.slice(start + 1);
  const end = rest.slice(1).search(/\n {4}[A-Za-z]|\n {0,3}\S/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}
function requiredOf(block: string | null): string[] {
  const m = block?.match(/\n {6}required:\n((?: {8}- [^\n]+\n?)+)/);
  return m ? [...m[1].matchAll(/- ([^\n]+)/g)].map((x) => x[1].trim()) : [];
}
function propType(block: string | null, prop: string): string | null {
  return block?.match(new RegExp(`\\n {8}${prop}:\\n {10}(?:type: (\\w+)|\\$ref: '([^']+)')`))?.slice(1).find(Boolean) ?? null;
}

async function spec() {
  let text: string;
  try {
    const r = await fetch(SPEC_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    text = (await r.text()).replace(/\r\n/g, "\n");
    if (!r.ok || !text.startsWith("openapi:")) {
      record("N1-spec", "FAIL", `spec not available (HTTP ${r.status})`, { url: SPEC_URL, body: short(text, 200) });
      return;
    }
  } catch (e) {
    record("N1-spec", "FAIL", "spec download failed", { url: SPEC_URL, error: errMsg(e) });
    return;
  }
  const need: Record<string, string[]> = {
    "/customers": ["GET", "POST"],
    "/customers/{id}": ["GET"],
    "/customers/{id}/accounts": ["GET", "POST"],
    "/accounts": ["GET"],
    "/accounts/{id}": ["GET", "DELETE"],
    "/accounts/{id}/customer": ["GET"],
    "/accounts/{id}/deposits": ["GET", "POST"],
    "/deposits/{id}": ["GET", "DELETE"],
  };
  const missing: string[] = [];
  const paths: Record<string, string> = {};
  for (const [p, methods] of Object.entries(need)) {
    const have = methodsOf(pathBlock(text, p));
    paths[p] = have.join(",") || "(absent)";
    for (const m of methods) if (!have.includes(m)) missing.push(`${m} ${p}`);
  }
  const schemas: Record<string, string> = {};
  for (const s of ["CustomerCreate", "Address", "AccountCreate", "DepositCreate"]) schemas[s] = requiredOf(schemaBlock(text, s)).join(", ") || "(not found)";
  const accountType = text.match(/\n {4}AccountType:\n[\s\S]*?enum: \[([^\]]+)\]/)?.[1] ?? "(not found)";
  const depositAmountType = propType(schemaBlock(text, "DepositCreate"), "amount");
  const servers = [...text.matchAll(/\n {2}- url: (\S+)/g)].map((m) => m[1]);
  const customerDelete = methodsOf(pathBlock(text, "/customers/{id}")).includes("DELETE");
  const postCustomer201 = pathBlock(text, "/customers")?.match(/'201':[\s\S]*?example: "([^"]+)"/)?.[1] ?? null;
  record("N1-spec", missing.length ? "FAIL" : "PASS",
    missing.length ? `spec is missing: ${missing.join("; ")}` : "OpenAPI spec has every Phase 3 endpoint (create/get customer, accounts, deposits, delete account/deposit)",
    {
      url: SPEC_URL, bytes: text.length, openapi: text.match(/^openapi: (\S+)/)?.[1], servers, paths,
      required_body_fields: schemas, account_type_enum: accountType, deposit_amount_type: depositAmountType,
      delete_customer_endpoint: customerDelete, post_customers_201_example: postCustomer201,
    });
}

// ---- N1-auth (read-only) ------------------------------------------------------------------------
interface Account { _id: string; type?: string; nickname?: string; customer_id?: string }
async function authReadOnly() {
  try {
    const c = await http("GET", withKey("/customers", KEY));
    const a = await http("GET", withKey("/accounts", KEY));
    const customers = Array.isArray(c.json) ? c.json : null;
    const accounts = Array.isArray(a.json) ? (a.json as Account[]) : null;
    const deposits: Record<string, string> = {};
    for (const acc of (accounts ?? []).slice(0, 3)) {
      const d = await http("GET", withKey(`/accounts/${acc._id}/deposits`, KEY));
      deposits[acc._id] = `HTTP ${d.status}, ${Array.isArray(d.json) ? `${d.json.length} deposits` : short(d.text, 80)}`;
    }
    const ok = c.status === 200 && a.status === 200 && customers !== null && accounts !== null;
    const empty = ok && customers!.length === 0 && accounts!.length === 0;
    record("N1-auth", ok ? (empty ? "PARTIAL" : "PASS") : "FAIL",
      ok ? `GET /customers -> ${customers!.length} customers, GET /accounts -> ${accounts!.length} accounts` +
           (empty ? " (both empty: Nessie also returns 200 [] for an INVALID key, so the key is not proven valid until a POST succeeds)" : "")
         : `read-only GETs failed (HTTP ${c.status} / ${a.status})`,
      { customers_status: c.status, customers_latency_ms: c.ms, customers_count: customers?.length, accounts_status: a.status, accounts_count: accounts?.length,
        deposits_first_3_accounts: Object.keys(deposits).length ? deposits : undefined,
        error_body: ok ? undefined : short(c.status === 200 ? a.text : c.text) });
  } catch (e) {
    record("N1-auth", "FAIL", "read-only GETs threw", { error: errMsg(e) });
  }
}

// ---- N1-write-smoke (opt-in) --------------------------------------------------------------------
async function writeSmoke() {
  const tag = `SmokeTest-${Date.now()}`;
  const ev: Record<string, unknown> = {};
  let accountId: string | undefined;
  let depositId: string | undefined;
  try {
    // Public address (NYC Municipal Building); no personal data goes into Nessie.
    const address = { street_number: "1", street_name: "Centre St", city: "New York", state: "NY", zip: "10007" };
    const pc = await http("POST", withKey("/customers", KEY), { first_name: "DivHacks", last_name: tag, address });
    ev.post_customer = `HTTP ${pc.status}: ${short(pc.text, 400)}`;
    const createdId = (pc.json as { objectCreated?: { _id?: string } } | null)?.objectCreated?._id;
    const list = await http("GET", withKey("/customers", KEY));
    const found = (Array.isArray(list.json) ? (list.json as { _id: string; last_name?: string }[]) : []).find((x) => x.last_name === tag);
    const customerId = createdId ?? found?._id;
    ev.customer_id_source = createdId ? "POST response objectCreated._id" : found ? "GET /customers lookup by last_name (POST did not return an id)" : "NOT FOUND";
    ev.customer_id_length = customerId?.length;
    if (!customerId) throw new Error("created customer not found");

    const pa = await http("POST", withKey(`/customers/${customerId}/accounts`, KEY), { type: "Checking", nickname: `divhacks-${tag}`, rewards: 0, balance: 0 });
    ev.post_account = `HTTP ${pa.status}: ${short(pa.text, 400)}`;
    const accs = await http("GET", withKey(`/customers/${customerId}/accounts`, KEY));
    const acc = (Array.isArray(accs.json) ? (accs.json as (Account & { account_number?: string })[]) : []).find((x) => x.nickname === `divhacks-${tag}`);
    accountId = (pa.json as { objectCreated?: { _id?: string } } | null)?.objectCreated?._id ?? acc?._id;
    ev.account = acc ? { id_length: acc._id.length, type: acc.type, account_number_length: acc.account_number?.length } : "NOT FOUND";
    if (!accountId) throw new Error("created account not found");

    const own = await http("GET", withKey(`/accounts/${accountId}/customer`, KEY));
    ev.get_account_customer = `HTTP ${own.status}: ${short(own.text, 200)}`;

    const amount = 37; // integer per spec; our convention: cents-sized micro-deposit, code also in description
    const pd = await http("POST", withKey(`/accounts/${accountId}/deposits`, KEY), {
      medium: "balance", transaction_date: new Date().toISOString().slice(0, 10), status: "completed", amount, description: `DIVHACKS-VERIFY ${tag}`,
    });
    ev.post_deposit = `HTTP ${pd.status}: ${short(pd.text, 400)}`;
    const deps = await http("GET", withKey(`/accounts/${accountId}/deposits`, KEY));
    const dep = (Array.isArray(deps.json) ? (deps.json as { _id: string; description?: string; amount?: number; status?: string }[]) : []).find((x) => x.description === `DIVHACKS-VERIFY ${tag}`);
    depositId = (pd.json as { objectCreated?: { _id?: string } } | null)?.objectCreated?._id ?? dep?._id;
    ev.deposit = dep ? { amount: dep.amount, status: dep.status } : "NOT FOUND";

    const ok = [pc, pa, pd].every((r) => r.status === 201) && !!depositId;
    record("N1-write-smoke", ok ? "PASS" : "PARTIAL", ok ? "create customer -> account -> deposit worked" : "write flow incomplete; see evidence", ev);
  } catch (e) {
    ev.error = errMsg(e);
    record("N1-write-smoke", "FAIL", "write flow failed", ev);
  } finally {
    const cleanup: Record<string, string> = {};
    if (depositId) { const r = await http("DELETE", withKey(`/deposits/${depositId}`, KEY)).catch((e) => ({ status: 0, text: errMsg(e) })); cleanup.delete_deposit = `HTTP ${r.status} ${short(r.text, 80)}`; }
    if (accountId) { const r = await http("DELETE", withKey(`/accounts/${accountId}`, KEY)).catch((e) => ({ status: 0, text: errMsg(e) })); cleanup.delete_account = `HTTP ${r.status} ${short(r.text, 80)}`; }
    cleanup.customer = "left in place (the spec has no DELETE /customers/{id})";
    record("N1-write-smoke-cleanup", "INFO", "cleanup", cleanup);
  }
}

async function main() {
  // https only; plain http is allowed for a localhost mock (tests).
  if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(BASE)) throw new Error(`NESSIE_BASE_URL must be https (or http://localhost for tests); got ${BASE}`);
  console.log(`Nessie risk check: base=${BASE} key=${KEY ? "present" : "MISSING"}${WRITE_SMOKE ? " (--write-smoke)" : ""}`);
  await reach();
  await spec();
  if (!KEY) {
    record("N1-auth", "BLOCKED", "NESSIE_API_KEY is empty in .env; a human must log in at https://nessieisreal.com with GitHub, copy the key into .env, then re-run (awaiting key)");
  } else {
    await authReadOnly();
    if (WRITE_SMOKE) await writeSmoke();
  }
  console.log(`\nRESULT_JSON ${redact(JSON.stringify(results.map(({ id, status, notes }) => ({ id, status, notes }))))}`);
  if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
}

main().catch((e) => { console.error(redact(errMsg(e))); process.exit(1); });
