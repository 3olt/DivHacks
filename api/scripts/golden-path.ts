// End-to-end golden path against a RUNNING mongo-mode API (it makes ONE real 12.50 RLUSD Testnet payment):
//   reset -> golden site_fbnyc is red (71) -> POST /demo/happy (real golden run) -> WS site_updated (red -> yellow 67)
//   then WS decision (released, explorer link) -> the trail shows the XRPL payment with explorer_url (and the ledger
//   confirms it) -> POST /demo/injection -> WS/decisions show the three refusals incl. the ledger's tefBAD_QUORUM ->
//   POST /dev/reset -> golden back to red.
//   API_URL=http://localhost:4000 npm run golden-path -w api
// Needs the co-signer / xrpl service / officer running, or the API's demo runner auto-spawns them (DEMO_NO_SPAWN unset).
// Prints PASS/FAIL per step and exits 1 on any failure.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import WebSocket from "ws";
import type { Decision, DemoRun, LiveMessage, Site, Trail } from "../../shared/contracts";

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env"), quiet: true });
const API = (process.env.GOLDEN_API_URL ?? process.env.API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const GOLDEN_SITE = "site_fbnyc";
const GOLDEN_CONTRACT = "CT106920258801736";
const RUN_TIMEOUT_MS = Number(process.env.GOLDEN_RUN_TIMEOUT_MS ?? 10 * 60_000);
const XRPL_RPC = process.env.XRPL_RPC ?? "https://s.altnet.rippletest.net:51234";

let passed = 0;
let failed = 0;
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
function step(name: string, ok: unknown, detail?: unknown): boolean {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} [${secs()}] ${name}${detail !== undefined && !ok ? ` -- ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 800)}` : ""}`);
  return Boolean(ok);
}
const info = (m: string) => console.log(`     ${m}`);

async function call<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed as T };
}

class Live {
  readonly messages: LiveMessage[] = [];
  private listeners: (() => void)[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      try {
        this.messages.push(JSON.parse(String(d)) as LiveMessage);
      } catch {
        return;
      }
      for (const l of this.listeners) l();
    });
  }
  static open(url: string): Promise<Live> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const live = new Live(ws);
      ws.once("open", () => resolve(live));
      ws.once("error", reject);
    });
  }
  /** Index of the first message at/after `from` matching `pred`, or -1 after the timeout. */
  waitFor(pred: (m: LiveMessage) => boolean, from: number, timeoutMs: number): Promise<number> {
    return new Promise((resolve) => {
      const scan = () => this.messages.findIndex((m, i) => i >= from && pred(m));
      const hit = scan();
      if (hit >= 0) return resolve(hit);
      const onMsg = () => {
        const i = scan();
        if (i >= 0) done(i);
      };
      const timer = setTimeout(() => done(-1), timeoutMs);
      const done = (i: number) => {
        clearTimeout(timer);
        this.listeners = this.listeners.filter((l) => l !== onMsg);
        resolve(i);
      };
      this.listeners.push(onMsg);
    });
  }
}

const isDecision = (m: LiveMessage): m is Extract<LiveMessage, { type: "decision" }> => m.type === "decision";
const isRun = (m: LiveMessage, runId: string, status: string) => m.type === "demo_run" && m.run_id === runId && m.status === status;

async function waitRunEnd(live: Live, runId: string, from: number): Promise<DemoRun | null> {
  const i = await live.waitFor((m) => m.type === "demo_run" && m.run_id === runId && m.status !== "running", from, RUN_TIMEOUT_MS);
  if (i < 0) return null;
  return (await call<DemoRun>("GET", `/demo/runs/${runId}`)).body;
}

async function ledgerTx(hash: string): Promise<{ validated?: boolean; result?: string; signers?: number } | null> {
  try {
    const r = await fetch(XRPL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "tx", params: [{ transaction: hash }] }), signal: AbortSignal.timeout(20000) });
    const j = (await r.json()) as { result?: { validated?: boolean; meta?: { TransactionResult?: string }; Signers?: unknown[]; tx_json?: { Signers?: unknown[] } } };
    return { validated: j.result?.validated, result: j.result?.meta?.TransactionResult, signers: (j.result?.Signers ?? j.result?.tx_json?.Signers)?.length };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log(`Golden path against ${API} (XRPL Testnet; one real 12.50 RLUSD payment to the golden demo wallet)\n`);
  const health = await call("GET", "/health");
  if (!step("GET /health: mongo mode, no demo run in progress", health.status === 200 && health.body?.mode === "mongo" && health.body?.demo_run === null, health.body)) process.exit(1);
  const live = await Live.open(`${API.replace(/^http/, "ws")}/live`);
  step("WS /live connected (hello mode mongo)", (await live.waitFor((m) => m.type === "hello" && m.mode === "mongo", 0, 5000)) >= 0);

  // 1. reset -> golden red (71)
  let from = live.messages.length;
  const reset = await call("POST", "/dev/reset");
  step("POST /dev/reset -> 200 (data/demo_reset.py)", reset.status === 200 && reset.body?.ok === true, reset.body);
  step("  ...WS site_updated for the golden site", (await live.waitFor((m) => m.type === "site_updated" && m.site_id === GOLDEN_SITE, from, 30_000)) >= 0);
  const before = (await call<Site>("GET", `/sites/${GOLDEN_SITE}`)).body;
  info(`golden before: ${before.risk.level} ${before.risk.score} "${before.risk.summary}"`);
  step("golden site_fbnyc is red (71) after reset", before.risk.level === "red" && before.risk.score === 71, before.risk);

  // 2. POST /demo/happy -> the real golden run
  from = live.messages.length;
  const happy = await call("POST", "/demo/happy");
  const runId: string = happy.body?.run_id;
  step("POST /demo/happy -> 202 {mode:mongo, run_id, status:started, decision:null} (happy -> golden)", happy.status === 202 && happy.body?.mode === "mongo" && typeof runId === "string" && happy.body?.status === "started" && happy.body?.decision === null && happy.body?.cli_scenario === "golden", happy.body);
  step("  ...WS demo_run running", (await live.waitFor((m) => isRun(m, runId, "running"), from, 5000)) >= 0);
  const busy = await call("POST", "/demo/injection");
  step("POST /demo/injection while it runs -> 409 run_in_progress (same run_id)", busy.status === 409 && busy.body?.error === "run_in_progress" && busy.body?.run_id === runId, busy.body);
  const busyReset = await call("POST", "/dev/reset");
  step("POST /dev/reset while it runs -> 409 run_in_progress", busyReset.status === 409 && busyReset.body?.error === "run_in_progress", busyReset.body);

  const decIdx = await live.waitFor((m) => isDecision(m) && m.decision.contract_id === GOLDEN_CONTRACT && m.decision.outcome === "released", from, RUN_TIMEOUT_MS);
  const released = decIdx >= 0 ? (live.messages[decIdx] as Extract<LiveMessage, { type: "decision" }>).decision : null;
  step("WS decision: released 12.50 RLUSD under the golden contract, agent + co-signer, tesSUCCESS", !!released && released.amount === "12.50" && released.currency === "RLUSD" && released.ledger_result === "tesSUCCESS" && !!released.xrpl_tx_hash && released.signers.join() === "agent,cosigner" && released.checks.every((c) => c.passed), released && { outcome: released.outcome, amount: released.amount, signers: released.signers });
  if (released) info(`explorer: https://testnet.xrpl.org/transactions/${released.xrpl_tx_hash}`);
  const suIdx = live.messages.findIndex((m, i) => i >= from && m.type === "site_updated" && m.site_id === GOLDEN_SITE);
  const su = suIdx >= 0 ? (live.messages[suIdx] as Extract<LiveMessage, { type: "site_updated" }>) : null;
  step("WS site_updated golden BEFORE the decision: red -> yellow 67 (data/risk.py, Option B demo scale)", !!su && suIdx < decIdx && su.risk.level === "yellow" && su.risk.score === 67, su && { suIdx, decIdx, level: su.risk.level, score: su.risk.score });
  if (su) info(`golden after: ${su.risk.level} ${su.risk.score}; first reason: "${su.risk.reasons[0]}"`);
  step("  ...the first reason discloses the demo scale (RLUSD 12.50 Testnet payment counted at 1 RLUSD = $10,000)", !!su && /RLUSD 12\.50 Testnet payment counted as \$125,000 at demo scale/.test(su.risk.reasons[0]));

  const run1 = await waitRunEnd(live, runId, from);
  step("demo run finished: GET /demo/runs/:id succeeded, exit 0, lists the released decision", run1?.status === "succeeded" && run1.exit_code === 0 && !!released && run1.decision_ids.includes(released.decision_id), run1 && { status: run1.status, exit: run1.exit_code, ids: run1.decision_ids, tail: run1.log_tail.slice(-8) });

  const site = (await call<Site>("GET", `/sites/${GOLDEN_SITE}`)).body;
  step("GET /sites/site_fbnyc -> yellow 67", site.risk.level === "yellow" && site.risk.score === 67, site.risk);
  const trail = (await call<Trail>("GET", `/sites/${GOLDEN_SITE}/trail`)).body;
  const pay = released ? trail.payments.find((p) => p.source === "xrpl" && p.xrpl_tx_hash === released.xrpl_tx_hash) : undefined;
  step("GET /sites/site_fbnyc/trail shows the XRPL payment with explorer_url", !!pay && pay.explorer_url === `https://testnet.xrpl.org/transactions/${released!.xrpl_tx_hash}` && pay.status === "released" && pay.amount === "12.50", pay);
  step("  ...and the decision is the newest in the trail", !!released && trail.decisions[0]?.decision_id === released.decision_id, trail.decisions[0]?.decision_id);
  if (released?.xrpl_tx_hash) {
    const tx = await ledgerTx(released.xrpl_tx_hash);
    step("the XRP Ledger (Testnet JSON-RPC) confirms it: validated, tesSUCCESS, 2 signers", tx?.validated === true && tx.result === "tesSUCCESS" && tx.signers === 2, tx);
  }

  // 3. POST /demo/injection -> three refusals, the last by the ledger (tefBAD_QUORUM)
  from = live.messages.length;
  const inj = await call("POST", "/demo/injection");
  const injRun: string = inj.body?.run_id;
  step("POST /demo/injection -> 202 started", inj.status === 202 && inj.body?.status === "started" && typeof injRun === "string", inj.body);
  const run2 = await waitRunEnd(live, injRun, from);
  const injDecisions = live.messages.slice(from).filter(isDecision).map((m) => m.decision);
  const a = injDecisions.find((d) => d.refusal_reasons[0] === "suspicious_instructions_in_invoice");
  const b = injDecisions.find((d) => d.enforced_by === "cosigner" && d.refusal_reasons.includes("credential_invalid") && d.refusal_reasons.includes("destination_not_registry_wallet"));
  const c = injDecisions.find((d) => d.enforced_by === "ledger" && d.ledger_result === "tefBAD_QUORUM");
  step("WS decision (a): agent policy refused (suspicious_instructions_in_invoice, enforced_by null, nothing signed)", !!a && a.outcome === "refused" && a.enforced_by === null && a.signers.length === 0, a && { reasons: a.refusal_reasons, enforced_by: a.enforced_by });
  step("WS decision (b): co-signer refused the compromised agent (credential_invalid + destination_not_registry_wallet)", !!b && b.outcome === "refused", b?.refusal_reasons);
  step("WS decision (c): the LEDGER refused the agent-only tx: tefBAD_QUORUM", !!c && c.outcome === "refused" && c.refusal_reasons.includes("ledger_rejected") && c.signers.join() === "agent", c && { reasons: c.refusal_reasons, ledger_result: c.ledger_result });
  step("injection run succeeded (exit 0) and lists its 3 decisions", run2?.status === "succeeded" && run2.exit_code === 0 && [a, b, c].every((d) => d && run2.decision_ids.includes(d.decision_id)), run2 && { status: run2.status, ids: run2.decision_ids, tail: run2.log_tail.slice(-8) });
  const feed = (await call<Decision[]>("GET", "/decisions?limit=10")).body;
  step("GET /decisions (newest first) shows the three refusals incl. tefBAD_QUORUM", [a, b, c].every((d) => d && feed.some((x) => x.decision_id === d.decision_id)) && feed.some((x) => x.ledger_result === "tefBAD_QUORUM"));
  const g2 = (await call<Site>("GET", `/sites/${GOLDEN_SITE}`)).body;
  step("refusals did not change the golden pin (still yellow 67)", g2.risk.level === "yellow" && g2.risk.score === 67, g2.risk);

  // 4. reset -> golden back to red
  from = live.messages.length;
  const reset2 = await call("POST", "/dev/reset");
  step("POST /dev/reset -> 200", reset2.status === 200 && reset2.body?.ok === true, reset2.body);
  const suBack = await live.waitFor((m) => m.type === "site_updated" && m.site_id === GOLDEN_SITE && m.risk.level === "red", from, 30_000);
  step("  ...WS site_updated: golden back to red", suBack >= 0);
  const after = (await call<Site>("GET", `/sites/${GOLDEN_SITE}`)).body;
  step("golden site_fbnyc is red (71) again", after.risk.level === "red" && after.risk.score === 71, after.risk);

  live.ws.close();
  console.log(`\n${passed} passed, ${failed} failed (${secs()})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log(`FAIL golden-path crashed -- ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
