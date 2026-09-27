// The xrpl service (XRPL_SERVICE_URL, default :4001): the AGENT side over HTTP. It loads ONLY the root .env +
// xrpl/.env.agent (AGENT_SEED, weight 1 of quorum 3), so everything it pays still needs the co-signer (separate process,
// :4002) and the ledger's quorum. It never holds the co-signer's or the officer's key.
//
//   GET  /health
//        200 {ok, role:"xrpl-service", agent_signer, agent_account, cosigner:{url, up, rule_version, policy_problems}}
//   POST /invoices   one of:
//        {invoice: Invoice}                                            (JSON invoice; contract + invoice id from it)
//        {invoice_text: string, contract_id, invoice_id?}               (plain text)
//        {pdf_path: string, contract_id, invoice_id?}                   (a PDF under xrpl/data/invoices/)
//        -> runs the Phase 2 pipeline (Grok verifier -> payment builder -> agent signs -> co-signer -> ledger) and returns
//        200 {ok:true, decision: Decision, stage, destination, explorer_url}   (refused decisions included; see outcome)
//        400 bad request, 503 co-signer policy mismatch (nothing built)
//   POST /payees/:ein/change-request  {new_address, reason, contact}
//        202 {ok:true, request: PayeeChangeRequest, cosigner:{recorded, active}}   (status "on_hold"; the registry is NOT changed)
//        400 / 404 {ok:false, error, message}
//   GET  /payees/:ein/change-requests  -> {ok, requests: PayeeChangeRequest[]}   (newest first)
//   Phase 3, builder B (./agentRoutes.ts): GET /approvals, POST /approvals/:decision_id/execute (called by the officer
//   service after the human approved), GET|POST /escrow/milestones, POST /escrow/milestones/:id/release (SIMULATED escrow)
//
// Requests that sign anything are handled one at a time (agent_account has one Sequence).
// Run: npm run xrpl:service   (repo root)
import Fastify from "fastify";
import { loadAgentWallet, type AgentCtx } from "../agent/payInvoice";
import { Recorder } from "../agent/record";
import { connect } from "../lib/xrpl";
import { loadRegistry } from "../lib/registry";
import { ensureIndexes, openMongo } from "../lib/mongo";
import { registerCoreRoutes } from "./routes";
import { registerAgentRoutes } from "./agentRoutes";

const agentWallet = loadAgentWallet(); // root .env + xrpl/.env.agent only; AGENT_SEED removed from process.env

function portFromUrl(): { host: string; port: number } {
  try {
    const u = new URL(process.env.XRPL_SERVICE_URL ?? "http://localhost:4001");
    return { host: u.hostname === "localhost" ? "localhost" : u.hostname, port: Number(u.port || 4001) };
  } catch {
    return { host: "localhost", port: 4001 };
  }
}

async function main() {
  const reg = loadRegistry();
  const client = await connect();
  const mongo = await openMongo("divhacks-xrpl-service");
  await ensureIndexes(mongo.db);
  const cosignerUrl = (process.env.COSIGNER_URL ?? "http://localhost:4002").replace(/\/$/, "");
  const log = (m: string) => console.log(`[xrpl-service] ${m}`);
  const ctx: AgentCtx = { agentWallet, client, db: mongo.db, recorder: new Recorder(mongo.db), reg, cosignerUrl, log };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  registerCoreRoutes(app, { ctx, db: mongo.db, reg, cosignerUrl, serial });
  // Phase 3, builder B: over-limit execution after the officer's approval, and the SIMULATED escrow (CTT test token).
  // (The kill switch lives on the officer service :4004: the agent side cannot revoke or restore anything.)
  const officerUrl = (process.env.OFFICER_URL ?? "http://localhost:4004").replace(/\/$/, "");
  registerAgentRoutes(app, { ctx, db: mongo.db, reg, cosignerUrl, serial, officerUrl });

  const shutdown = () => {
    Promise.allSettled([app.close(), client.disconnect(), mongo.close()]).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const { host, port } = portFromUrl();
  if (port === 4003) throw new Error("port 4003 belongs to the iMessage service; set XRPL_SERVICE_URL to another port");
  await app.listen({ port, host });
  log(`listening on http://${host}:${port} (agent signer ${agentWallet.address}, weight 1 of quorum 3; co-signer ${cosignerUrl}; pid ${process.pid})`);
}

main().catch((e) => {
  console.error(`[xrpl-service] startup failed: ${(e as Error).message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>")}`);
  process.exit(1);
});
