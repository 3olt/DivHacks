// The OFFICER's click CLI (Phase 3 fixes): the human officer's buttons on the officer service (OFFICER_URL, :4004).
// This process loads ONLY the root .env + xrpl/.env.officer and uses OFFICER_CLICK_TOKEN from there (never printed, never
// passed on); it drops OFFICER_SEED at once (it signs nothing itself: the officer service does). It refuses to run if any other
// *_SEED is in its environment. The agent processes (xrpl service, demo runner) do not hold the token, so they cannot press
// these buttons over HTTP; the demo starts this CLI as a separate process to stand in for the human's click.
//
//   npm run officer:click -- approve <decision_id>          shows the pending over-limit payment from the officer's inbox, then
//                                                           approves exactly that {amount, destination, decision_hash}
//   npm run officer:click -- revoke | restore               kill switch: SignerListSet REVOKED / CANONICAL (officer + co-signer)
//   npm run officer:click -- resolve <ein> <request_id> reject
//   npm run officer:click -- resolve <ein> <request_id> approve --confirm-freeze   (keeps the EIN frozen; see README)
//   npm run officer:click -- approve-release <milestone_id> SIMULATED escrow (CTT test token): approve one milestone release
//
// The last output line is `OFFICER_CLICK_RESULT {"status":<http>,"body":{...}}` (for scripts). Exit 0 if HTTP 2xx, else 1.
import { loadEnv } from "../src/env";

loadEnv("officer");

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const foreign = Object.keys(process.env).filter((k) => k.endsWith("_SEED") && k !== "OFFICER_SEED");
  if (foreign.length) throw new Error(`refusing to run: other seeds are present in this process's environment (${foreign.join(", ")})`);
  delete process.env.OFFICER_SEED; // not needed here: the officer SERVICE holds and uses the officer key
  const token = process.env.OFFICER_CLICK_TOKEN ?? "";
  delete process.env.OFFICER_CLICK_TOKEN;
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('OFFICER_CLICK_TOKEN missing in xrpl/.env.officer: run "npm run setup:xrpl"');
  const base = (process.env.OFFICER_URL ?? "http://localhost:4004").replace(/\/$/, "");
  const [cmd, a1, a2, a3] = args;

  const post = async (p: string, body: unknown = {}): Promise<number> => {
    let status = 0;
    let j: Record<string, unknown> = {};
    try {
      const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-officer-token": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
      status = r.status;
      j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (e) {
      j = { ok: false, error: "officer_unreachable", message: `officer service at ${base} unreachable (${(e as Error).message})` };
    }
    console.log(`officer service: POST ${p} -> HTTP ${status || "none"}${j.error ? ` ${String(j.error)}` : ""}${j.message ? `: ${String(j.message).slice(0, 300)}` : ""}`);
    console.log(`OFFICER_CLICK_RESULT ${JSON.stringify({ status, body: j })}`);
    return status >= 200 && status < 300 ? 0 : 1;
  };

  if (cmd === "approve" && a1) {
    // Show the officer what is pending (the officer's inbox), then approve exactly that.
    const inbox = (await fetch(`${base}/approvals`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json())) as { approvals?: { decision_id: string; status: string; amount: string; destination: string; decision_hash: string; invoice_id: string; contract_id: string; payee_ein: string; expires_at: string }[] };
    const p = inbox.approvals?.find((x) => x.decision_id === a1);
    if (!p) {
      console.log(`officer inbox: no pending approval ${a1}`);
      console.log(`OFFICER_CLICK_RESULT ${JSON.stringify({ status: 404, body: { ok: false, error: "not_found" } })}`);
      return 1;
    }
    console.log(`officer inbox: ${p.decision_id} [${p.status}] ${p.amount} RLUSD -> ${p.destination} (EIN ${p.payee_ein}, contract ${p.contract_id}, invoice ${p.invoice_id}); dh ${p.decision_hash.slice(0, 16)}...; expires ${p.expires_at}`);
    console.log(`the officer approves exactly this payment (the officer service re-verifies it against the pending decision, its own registry file and the co-signer's record)`);
    return post(`/approvals/${encodeURIComponent(a1)}`, { amount: p.amount, destination: p.destination, decision_hash: p.decision_hash });
  }
  if (cmd === "revoke" || cmd === "restore") return post(`/agent/${cmd}`);
  if (cmd === "resolve" && a1 && a2 && (a3 === "reject" || a3 === "approve")) {
    if (a3 === "approve" && !args.includes("--confirm-freeze")) {
      console.error("approve keeps every payment to this EIN frozen until the requested wallet is re-onboarded, which this build does not automate. Add --confirm-freeze to do it anyway; reject is the normal answer.");
      return 2;
    }
    return post(`/payees/${encodeURIComponent(a1)}/change-requests/${encodeURIComponent(a2)}/resolve`, { decision: a3, ...(a3 === "approve" ? { confirm_freeze: true } : {}) });
  }
  if (cmd === "approve-release" && a1) return post(`/escrow/milestones/${encodeURIComponent(a1)}/approve-release`);
  console.error("usage: npm run officer:click -- approve <decision_id> | revoke | restore | resolve <ein> <request_id> reject|approve [--confirm-freeze] | approve-release <milestone_id>");
  return 2;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error("officer-click failed:", e instanceof Error ? e.message : e);
    console.log(`OFFICER_CLICK_RESULT ${JSON.stringify({ status: 0, body: { ok: false, error: "officer_click_failed", message: e instanceof Error ? e.message : String(e) } })}`);
    process.exit(1);
  },
);
