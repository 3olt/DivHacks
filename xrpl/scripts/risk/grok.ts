// Phase 0 risk check G1: is the Grok (xAI) API reachable, and do structured outputs + image input work?
// Re-runnable: `cd xrpl && npx tsx scripts/risk/grok.ts [--no-vision] [--no-responses]`
//
// Without XAI_API_KEY (repo-root .env) only the unauthenticated reachability check runs; the rest is
// reported BLOCKED. With a key it also: lists models, runs a Chat Completions request with a
// response_format json_schema, the same through the Responses API (text.format), and an image-input
// request (a PNG generated in memory) with a json_schema output. The key is never printed.
// Findings and doc citations: scripts/risk/README-services.md.
import zlib from "node:zlib";
import { loadEnv } from "../../src/env";

loadEnv();

const BASE = (process.env.XAI_BASE_URL ?? "https://api.x.ai/v1").replace(/\/+$/, "");
const KEY = (process.env.XAI_API_KEY ?? "").trim();
// grok-4.3: text+image -> text, structured outputs, reasoning_effort none|low|medium|high|xhigh (default low).
const TEXT_MODEL = process.env.GROK_MODEL ?? "grok-4.3";
const VISION_MODEL = process.env.GROK_VISION_MODEL ?? TEXT_MODEL;
const REASONING_EFFORT = process.env.GROK_REASONING_EFFORT; // optional, e.g. "none" for grok-4.3
const TIMEOUT_MS = 120_000;
const argv = new Set(process.argv.slice(2));

type Status = "PASS" | "FAIL" | "PARTIAL" | "BLOCKED";
interface CheckResult { id: string; status: Status; notes: string; evidence: Record<string, unknown> }
const results: CheckResult[] = [];

function redact(s: string): string {
  let out = s;
  if (KEY) out = out.split(KEY).join("***");
  return out.replace(/xai-[A-Za-z0-9_-]{8,}/g, "xai-***");
}

function record(id: string, status: Status, notes: string, evidence: Record<string, unknown> = {}) {
  const ev = Object.fromEntries(Object.entries(evidence).filter(([, v]) => v !== undefined));
  results.push({ id, status, notes, evidence: ev });
  console.log(`\n[${status}] ${id}: ${redact(notes)}`);
  for (const [k, v] of Object.entries(ev)) console.log(`   ${k}: ${redact(typeof v === "string" ? v : String(JSON.stringify(v)))}`);
}

interface HttpResult { status: number; ms: number; text: string; json: unknown; headers: Headers }

async function http(method: "GET" | "POST", path: string, opts: { auth: boolean; body?: unknown }): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.auth) headers.Authorization = `Bearer ${KEY}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ms, text, json, headers: res.headers };
}

const short = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}...(${s.length} chars)` : s);
const errMsg = (e: unknown) => {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  return [err?.message, err?.cause?.code, err?.cause?.message].filter(Boolean).join(" | ");
};

// ---- the {ok, model} schema the task asks for ---------------------------------------------------
const HEALTH_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" }, model: { type: "string" } },
  required: ["ok", "model"],
  additionalProperties: false,
} as const;
const HEALTH_MESSAGES = [
  { role: "system", content: "You are an API connectivity check. Answer only with JSON matching the provided schema." },
  { role: "user", content: `Set ok to true and set model to the model id this request was sent to ("${TEXT_MODEL}").` },
];
function isHealth(x: unknown): x is { ok: boolean; model: string } {
  const o = x as Record<string, unknown>;
  return !!o && typeof o === "object" && typeof o.ok === "boolean" && typeof o.model === "string" && Object.keys(o).length === 2;
}

// ---- tiny solid-colour PNG without dependencies -------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- checks -------------------------------------------------------------------------------------
async function reach() {
  try {
    const r = await http("GET", "/models", { auth: false });
    const body = r.json as Record<string, unknown> | null;
    const shape = body && typeof body === "object" ? Object.keys(body) : null;
    const ok = r.status === 401 || r.status === 200;
    record("G1-reach", ok ? "PASS" : "FAIL",
      ok ? `GET ${BASE}/models without a key answered HTTP ${r.status} (reachable; 401 is expected without a key)`
         : `unexpected HTTP ${r.status} from ${BASE}/models`,
      { url: `GET ${BASE}/models (no Authorization header)`, status: r.status, latency_ms: r.ms, body: short(r.text), body_keys: shape, server: r.headers.get("server") });
  } catch (e) {
    record("G1-reach", "FAIL", `could not reach ${BASE}/models`, { error: errMsg(e) });
  }
}

/** Returns false when the key was rejected (xAI answers a bad key with HTTP 400 "invalid-argument"). */
async function listModels(): Promise<boolean> {
  const ids: string[] = [];
  try {
    const r = await http("GET", "/models", { auth: true });
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      record("G1-auth", "FAIL", `XAI_API_KEY was rejected (HTTP ${r.status}); fix the key in .env and re-run`, { status: r.status, body: short(r.text) });
      return false;
    }
    const data = (r.json as { data?: { id: string; aliases?: string[] }[] } | null)?.data ?? [];
    for (const m of data) ids.push(m.id, ...(m.aliases ?? []));
    const lm = await http("GET", "/language-models", { auth: true });
    const models = (lm.json as { models?: { id: string; aliases?: string[]; input_modalities?: string[]; output_modalities?: string[]; capabilities?: { reasoning_effort?: string[]; default_reasoning_effort?: string | null } }[] } | null)?.models ?? [];
    for (const m of models) ids.push(m.id, ...(m.aliases ?? []));
    const table = models.map((m) => `${m.id} in=${(m.input_modalities ?? []).join("+")} out=${(m.output_modalities ?? []).join("+")} effort=${(m.capabilities?.reasoning_effort ?? []).join("/") || "-"}${m.aliases?.length ? ` aliases=${m.aliases.join(",")}` : ""}`);
    const okStatus = r.status === 200 && lm.status === 200;
    const hasText = ids.includes(TEXT_MODEL), hasVision = ids.includes(VISION_MODEL);
    record("G1-auth-models", okStatus && hasText && hasVision ? "PASS" : okStatus ? "PARTIAL" : "FAIL",
      okStatus ? `key accepted; ${data.length} models via /models; configured text model ${TEXT_MODEL} ${hasText ? "listed" : "NOT listed"}, vision model ${VISION_MODEL} ${hasVision ? "listed" : "NOT listed"}`
               : `model listing failed (HTTP ${r.status} / ${lm.status})`,
      { models_status: r.status, language_models_status: lm.status, model_ids: data.map((m) => m.id), language_models: table, error_body: okStatus ? undefined : short(r.status === 200 ? lm.text : r.text) });
  } catch (e) {
    record("G1-auth-models", "FAIL", "model listing threw", { error: errMsg(e) });
  }
  return true;
}

async function chatJson() {
  const body: Record<string, unknown> = {
    model: TEXT_MODEL,
    messages: HEALTH_MESSAGES,
    response_format: { type: "json_schema", json_schema: { name: "health_check", strict: true, schema: HEALTH_SCHEMA } },
  };
  if (REASONING_EFFORT) body.reasoning_effort = REASONING_EFFORT;
  try {
    const r = await http("POST", "/chat/completions", { auth: true, body });
    const j = r.json as { model?: string; choices?: { message?: { content?: string } }[]; usage?: unknown } | null;
    const content = j?.choices?.[0]?.message?.content ?? "";
    let parsed: unknown = null;
    try { parsed = JSON.parse(content); } catch { /* reported below */ }
    const ok = r.status === 200 && isHealth(parsed) && parsed.ok === true;
    record("G1-auth-chat-json_schema", ok ? "PASS" : "FAIL",
      ok ? `POST /chat/completions with response_format json_schema returned schema-valid JSON in ${r.ms} ms`
         : `chat completion did not return schema-valid {ok:true, model} (HTTP ${r.status})`,
      { request_model: TEXT_MODEL, reasoning_effort: REASONING_EFFORT ?? "(model default)", status: r.status, latency_ms: r.ms, response_model: j?.model, content: short(content), parsed, usage: j?.usage, error_body: r.status === 200 ? undefined : short(r.text) });
  } catch (e) {
    record("G1-auth-chat-json_schema", "FAIL", "chat completion threw", { error: errMsg(e) });
  }
}

async function responsesJson() {
  const body: Record<string, unknown> = {
    model: TEXT_MODEL,
    input: HEALTH_MESSAGES,
    text: { format: { type: "json_schema", name: "health_check", schema: HEALTH_SCHEMA, strict: true } },
    store: false,
  };
  if (REASONING_EFFORT) body.reasoning = { effort: REASONING_EFFORT };
  try {
    const r = await http("POST", "/responses", { auth: true, body });
    const j = r.json as { model?: string; output_text?: string; output?: { type?: string; content?: { type?: string; text?: string }[] }[]; usage?: unknown } | null;
    const text = j?.output_text
      ?? j?.output?.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text
      ?? "";
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* reported below */ }
    const ok = r.status === 200 && isHealth(parsed) && parsed.ok === true;
    record("G1-auth-responses-json_schema", ok ? "PASS" : "FAIL",
      ok ? `POST /responses with text.format json_schema returned schema-valid JSON in ${r.ms} ms`
         : `Responses API did not return schema-valid {ok:true, model} (HTTP ${r.status})`,
      { request_model: TEXT_MODEL, status: r.status, latency_ms: r.ms, response_model: j?.model, output_text: short(text), parsed, usage: j?.usage, error_body: r.status === 200 ? undefined : short(r.text) });
  } catch (e) {
    record("G1-auth-responses-json_schema", "FAIL", "Responses API call threw", { error: errMsg(e) });
  }
}

async function visionJson() {
  const png = solidPng(64, 64, [220, 30, 30]);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const schema = {
    type: "object",
    properties: { dominant_color: { type: "string", enum: ["red", "green", "blue", "white", "black", "other"] }, image_seen: { type: "boolean" } },
    required: ["dominant_color", "image_seen"],
    additionalProperties: false,
  };
  const body: Record<string, unknown> = {
    model: VISION_MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
        { type: "text", text: "What is the dominant colour of this image? Answer with JSON matching the schema." },
      ],
    }],
    response_format: { type: "json_schema", json_schema: { name: "vision_check", strict: true, schema } },
  };
  if (REASONING_EFFORT) body.reasoning_effort = REASONING_EFFORT;
  try {
    const r = await http("POST", "/chat/completions", { auth: true, body });
    const j = r.json as { model?: string; choices?: { message?: { content?: string } }[]; usage?: unknown } | null;
    const content = j?.choices?.[0]?.message?.content ?? "";
    let parsed: { dominant_color?: string; image_seen?: boolean } | null = null;
    try { parsed = JSON.parse(content); } catch { /* reported below */ }
    const ok = r.status === 200 && parsed?.dominant_color === "red";
    record("G1-auth-vision", ok ? "PASS" : r.status === 200 && parsed ? "PARTIAL" : "FAIL",
      ok ? `image input (base64 PNG data URL) + json_schema worked in ${r.ms} ms; model saw the red test image`
         : `vision check HTTP ${r.status}; parsed=${JSON.stringify(parsed)}`,
      { request_model: VISION_MODEL, image: `64x64 solid red PNG, ${png.length} bytes`, status: r.status, latency_ms: r.ms, response_model: j?.model, parsed, usage: j?.usage, error_body: r.status === 200 ? undefined : short(r.text) });
  } catch (e) {
    record("G1-auth-vision", "FAIL", "vision call threw", { error: errMsg(e) });
  }
}

async function main() {
  // https only; plain http is allowed for a localhost mock (tests) so the key never leaves the machine unencrypted.
  if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(BASE)) throw new Error(`XAI_BASE_URL must be https (or http://localhost for tests); got ${BASE}`);
  console.log(`Grok risk check: base=${BASE} text_model=${TEXT_MODEL} vision_model=${VISION_MODEL} key=${KEY ? "present" : "MISSING"}`);
  await reach();
  if (!KEY) {
    record("G1-auth", "BLOCKED", "XAI_API_KEY is empty in .env; add it and re-run `npx tsx scripts/risk/grok.ts` (awaiting key)");
  } else if (await listModels()) {
    await chatJson();
    if (!argv.has("--no-responses")) await responsesJson();
    if (!argv.has("--no-vision")) await visionJson();
  }
  const summary = results.map(({ id, status, notes }) => ({ id, status, notes }));
  console.log(`\nRESULT_JSON ${redact(JSON.stringify(summary))}`);
  if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
}

main().catch((e) => { console.error(redact(errMsg(e))); process.exit(1); });
