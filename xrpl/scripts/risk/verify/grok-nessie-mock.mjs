// Adversarial verification of the AUTHENTICATED code paths in scripts/risk/grok.ts and nessie.ts.
// Starts an in-process mock of api.x.ai + api.nessieisreal.com on 127.0.0.1 (ephemeral port), runs each
// script as a child process pointed at the mock with an obviously fake key, records the request shapes
// the scripts send, then shuts the mock down. No real API key or real service is involved.
// Run: node xrpl/scripts/risk/verify/grok-nessie-mock.mjs   (from the repo root)
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const xrplDir = path.resolve(here, "../../..");
const tsxCli = path.resolve(xrplDir, "../node_modules/tsx/dist/cli.mjs");
const GOOD = "mock-good-key-not-real";
const seen = [];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const body = raw ? JSON.parse(raw) : undefined;
    // ---- xAI mock ----
    if (u.pathname.startsWith("/v1/")) {
      const auth = req.headers.authorization ?? "";
      if (!auth) return send(res, 401, { code: "unauthenticated:no-credentials", error: "No credentials presented." });
      if (auth !== `Bearer ${GOOD}`) return send(res, 400, { code: "invalid-argument", error: "Incorrect API key provided." });
      if (u.pathname === "/v1/models") return send(res, 200, { object: "list", data: [{ id: "grok-4.3", aliases: ["grok-4.3-latest"] }, { id: "grok-4.7", aliases: [] }] });
      if (u.pathname === "/v1/language-models") return send(res, 200, { models: [{ id: "grok-4.3", aliases: ["grok-4.3-latest"], input_modalities: ["text", "image"], output_modalities: ["text"], capabilities: { reasoning_effort: ["none", "low", "medium", "high", "xhigh"], default_reasoning_effort: "low" } }] });
      if (u.pathname === "/v1/chat/completions") {
        const content = body.messages?.[0]?.content;
        const hasImage = Array.isArray(content) && content.some((c) => c.type === "image_url" && String(c.image_url?.url).startsWith("data:image/png;base64,"));
        seen.push({ ep: "chat", model: body.model, rf_type: body.response_format?.type, rf_keys: Object.keys(body.response_format?.json_schema ?? {}).sort(), strict: body.response_format?.json_schema?.strict, hasImage, reasoning_effort: body.reasoning_effort });
        const text = hasImage ? { dominant_color: "red", image_seen: true } : { ok: true, model: body.model };
        return send(res, 200, { model: body.model, choices: [{ message: { role: "assistant", content: JSON.stringify(text) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      if (u.pathname === "/v1/responses") {
        seen.push({ ep: "responses", model: body.model, fmt: body.text?.format?.type, fmt_keys: Object.keys(body.text?.format ?? {}).sort(), store: body.store, input_is_array: Array.isArray(body.input) });
        // Real Responses payload shape per docs (output[].content[].output_text); no top-level output_text.
        return send(res, 200, { model: body.model, output: [{ type: "reasoning" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ok: true, model: body.model }) }] }], usage: { input_tokens: 1 } });
      }
      return send(res, 404, { error: "mock: unknown path" });
    }
    // ---- Nessie mock ----
    const key = u.searchParams.get("key");
    seen.push({ ep: "nessie", method: req.method, path: u.pathname, key: key === GOOD ? "GOOD" : key ? "other" : "none" });
    if (u.pathname === "/atms") return send(res, 200, [{}, {}]);
    if (!key) return send(res, 502, { message: "Internal server error" });
    if (key !== GOOD) return send(res, 200, []);
    if (u.pathname === "/customers") return send(res, 200, [{ _id: "c".repeat(36), first_name: "A", last_name: "B", address: {} }]);
    if (u.pathname === "/accounts") return send(res, 200, [{ _id: "a".repeat(36), type: "Checking", nickname: "n" }]);
    if (/^\/accounts\/[^/]+\/deposits$/.test(u.pathname)) return send(res, 200, []);
    return send(res, 404, "\"not in mock\"");
  });
});

function run(script, env, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, script, ...args], { cwd: xrplDir, env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const g = await run("scripts/risk/grok.ts", { XAI_BASE_URL: `${base}/v1`, XAI_API_KEY: GOOD });
    console.log(`=== grok.ts with mock + good key: exit ${g.code}`);
    console.log(g.out.split("\n").filter((l) => /^\[|RESULT_JSON/.test(l)).join("\n"));
    const gb = await run("scripts/risk/grok.ts", { XAI_BASE_URL: `${base}/v1`, XAI_API_KEY: "wrong-key-not-real" });
    console.log(`=== grok.ts with mock + wrong key: exit ${gb.code}`);
    console.log(gb.out.split("\n").filter((l) => /^\[/.test(l)).join("\n"));
    const n = await run("scripts/risk/nessie.ts", { NESSIE_BASE_URL: base, NESSIE_API_KEY: GOOD });
    console.log(`=== nessie.ts with mock + good key: exit ${n.code}`);
    console.log(n.out.split("\n").filter((l) => /^\[|RESULT_JSON/.test(l)).join("\n"));
    const leaked = [g.out, gb.out, n.out].some((o) => o.includes(GOOD));
    console.log(`=== key string printed by any script: ${leaked}`);
    console.log("=== request shapes seen by mock:");
    for (const s of seen) console.log(JSON.stringify(s));
  } finally {
    server.close(() => console.log("mock server closed"));
  }
});
