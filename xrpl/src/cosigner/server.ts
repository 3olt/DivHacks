// Compliance co-signer: a SEPARATE process with its own key (weight 2 on agent_account's signer list).
// It loads ONLY the root .env + xrpl/.env.cosigner, holds only COSIGNER_SEED, and never receives LLM text:
// it decodes the transaction it is asked to sign, runs its own checks, and either co-signs that exact
// transaction or refuses (HTTP 422) without signing.
//
// What it trusts, and where it comes from:
//   - policy (registry + allowlist): read ONCE at startup and pinned by SHA-256; later edits on disk are ignored
//     (and reported in /health) until a restart.
//   - AUTO_LIMIT: root .env, read once at startup.
//   - ledger state: its OWN connection to XRPL Testnet (agent_account's current Sequence, validated ledger index).
//   - what it already signed: its own append-only record xrpl/data/cosigner-signed.local.jsonl (written BEFORE a
//     signature is returned; if the write fails, no signature leaves the process).
//
//   GET  /health  -> {ok, role:"cosigner", signer_address, rule_version, allowlist_size, auto_limit, policy, signed_count}
//   POST /cosign  {tx_blob, invoice_id, decision_id}
//        200 {ok:true, signer:"cosigner", signer_address, signed_blob, checks}
//        422 {ok:false, refusal_reasons, checks}          (nothing signed)
//        400 {ok:false, error:"bad_request", message}     (malformed request; nothing signed)
//        503 {ok:false, error:"ledger_unavailable", message}  (could not read the ledger; nothing signed)
//        500 {ok:false, error:"record_write_failed", message} (could not record the signature; nothing returned)
//
// Run: npm run cosigner   (repo root or xrpl/)
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { Wallet, decode, type Client, type Transaction } from "xrpl";
import { loadEnv, paths } from "../env";
import { readPinnedPolicy, sha256File } from "../lib/registry";
import { connect, rlusd, sourceTag } from "../lib/xrpl";
import { runPhase1Checks, COSIGNER_RULE_VERSION, type LedgerView, type SignedRecord } from "./checks";

loadEnv("cosigner");

// Key isolation: this process must hold exactly one seed, its own.
const foreign = Object.keys(process.env).filter((k) => k.endsWith("_SEED") && k !== "COSIGNER_SEED");
if (foreign.length) {
  console.error(`[cosigner] refusing to start: other signing seeds are present in this process's environment (${foreign.join(", ")})`);
  process.exit(1);
}
const seed = process.env.COSIGNER_SEED;
if (!seed) {
  console.error('[cosigner] COSIGNER_SEED missing: run "npm run setup:xrpl" to generate xrpl/.env.cosigner');
  process.exit(1);
}
const wallet = Wallet.fromSeed(seed);
delete process.env.COSIGNER_SEED;

// Policy pinned at startup.
const policy = readPinnedPolicy();
const registry = policy.registry.data;
const allowlist = new Set(policy.allowlist.data.addresses);
const pinnedAt = new Date().toISOString();
if (registry.signers.cosigner.address !== wallet.address) {
  console.error(`[cosigner] COSIGNER_SEED derives ${wallet.address}, but the registry's cosigner is ${registry.signers.cosigner.address}; refusing to start`);
  process.exit(1);
}
const RL = rlusd();
if (registry.rlusd.issuer !== RL.issuer || registry.rlusd.currency !== RL.currency) {
  console.error("[cosigner] RLUSD issuer/currency in the root .env differ from the registry; refusing to start");
  process.exit(1);
}
const AUTO_LIMIT = Number(process.env.AUTO_LIMIT ?? "25");
if (!(AUTO_LIMIT > 0)) {
  console.error(`[cosigner] AUTO_LIMIT ${process.env.AUTO_LIMIT} is not a positive number; refusing to start`);
  process.exit(1);
}
const SOURCE_TAG = sourceTag();

// The co-signer's own signing record.
const signedPath = path.join(paths.dataDir, "cosigner-signed.local.jsonl");
const signed: SignedRecord[] = fs.existsSync(signedPath)
  ? fs.readFileSync(signedPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as SignedRecord)
  : [];

function portFromEnv(): number {
  if (process.env.COSIGNER_PORT) return Number(process.env.COSIGNER_PORT);
  try {
    const u = new URL(process.env.COSIGNER_URL ?? "http://localhost:4002");
    if (u.port) return Number(u.port);
  } catch {
    /* fall through */
  }
  return 4002;
}
const PORT = portFromEnv();
const HOST = process.env.COSIGNER_HOST ?? "localhost";

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const BLOB_RE = /^[0-9A-Fa-f]{2,20000}$/;

function logLine(fields: Record<string, unknown>) {
  console.log(`[cosigner] ${JSON.stringify({ ts: new Date().toISOString(), ...fields })}`);
}

function policyDrift(): { registry_on_disk_matches: boolean; allowlist_on_disk_matches: boolean } {
  const same = (p: string, h: string) => {
    try {
      return sha256File(p) === h;
    } catch {
      return false;
    }
  };
  return { registry_on_disk_matches: same(policy.registry.path, policy.registry.sha256), allowlist_on_disk_matches: same(policy.allowlist.path, policy.allowlist.sha256) };
}

// Own XRPL connection (lazy, reconnects if it drops).
let client: Client | null = null;
async function ledgerView(): Promise<LedgerView> {
  if (!client || !client.isConnected()) {
    if (client) await client.disconnect().catch(() => undefined);
    client = await connect();
  }
  const info = await client.request({ command: "account_info", account: registry.agent_account, ledger_index: "current" });
  const validatedLedger = await client.getLedgerIndex();
  return { accountSequence: info.result.account_data.Sequence, validatedLedger };
}

// One /cosign at a time, so two concurrent requests cannot both pass the "not signed before" checks.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

app.get("/health", async () => ({
  ok: true,
  role: "cosigner",
  signer_address: wallet.address,
  rule_version: COSIGNER_RULE_VERSION,
  allowlist_size: allowlist.size,
  auto_limit: AUTO_LIMIT,
  policy: { pinned_at: pinnedAt, registry_sha256: policy.registry.sha256, allowlist_sha256: policy.allowlist.sha256, ...policyDrift() },
  signed_count: signed.length,
}));

app.post("/cosign", (req, reply) =>
  serial(async () => {
    const body = req.body as Record<string, unknown> | null;
    const bad = (message: string) => {
      logLine({ decision_id: body?.decision_id ?? null, invoice_id: body?.invoice_id ?? null, destination: null, result: "bad_request", message });
      return reply.code(400).send({ ok: false, error: "bad_request", message });
    };
    if (!body || typeof body !== "object" || Array.isArray(body)) return bad("body must be a JSON object");
    const keys = Object.keys(body).sort();
    if (keys.join(",") !== "decision_id,invoice_id,tx_blob") return bad("body must contain exactly {tx_blob, invoice_id, decision_id}");
    const { tx_blob, invoice_id, decision_id } = body as { tx_blob: unknown; invoice_id: unknown; decision_id: unknown };
    if (typeof tx_blob !== "string" || !BLOB_RE.test(tx_blob)) return bad("tx_blob must be a hex string");
    if (typeof invoice_id !== "string" || !ID_RE.test(invoice_id)) return bad("invoice_id must match [A-Za-z0-9_.:-]{1,128}");
    if (typeof decision_id !== "string" || !ID_RE.test(decision_id)) return bad("decision_id must match [A-Za-z0-9_.:-]{1,128}");

    let tx: Record<string, unknown>;
    try {
      tx = decode(tx_blob) as Record<string, unknown>;
    } catch (e) {
      return bad(`tx_blob does not decode: ${(e as Error).message}`);
    }

    let ledger: LedgerView;
    try {
      ledger = await ledgerView();
    } catch (e) {
      const message = `could not read agent_account / validated ledger from ${process.env.XRPL_WS ?? "XRPL Testnet"}: ${(e as Error).message}`;
      logLine({ decision_id, invoice_id, destination: null, result: "ledger_unavailable", message });
      return reply.code(503).send({ ok: false, error: "ledger_unavailable", message });
    }

    const drift = policyDrift();
    if (!drift.registry_on_disk_matches || !drift.allowlist_on_disk_matches) {
      logLine({ warning: "policy files changed on disk since startup; still using the pinned copy (restart the co-signer to adopt them)", ...drift });
    }

    const { checks, refusal_reasons } = runPhase1Checks(tx, {
      agentAccount: registry.agent_account,
      allowlist,
      rlusd: RL,
      sourceTag: SOURCE_TAG,
      invoiceId: invoice_id,
      autoLimit: AUTO_LIMIT,
      ledger,
      signed,
    });
    const destination = typeof tx.Destination === "string" ? tx.Destination : null;

    if (refusal_reasons.length > 0 || checks.some((c) => !c.passed)) {
      logLine({ decision_id, invoice_id, destination, result: "refused", refusal_reasons });
      return reply.code(422).send({ ok: false, refusal_reasons, checks });
    }

    // Sign the SAME transaction that was checked: strip the agent's Signers and add our multisig signature.
    const txJson = { ...tx };
    delete txJson.Signers;
    let signed_blob: string;
    try {
      signed_blob = wallet.sign(txJson as unknown as Transaction, true).tx_blob;
    } catch (e) {
      return bad(`transaction failed validation: ${(e as Error).message}`);
    }

    // Record BEFORE the signature leaves this process.
    const rec: SignedRecord = {
      ts: new Date().toISOString(),
      invoice_id,
      decision_id,
      sequence: tx.Sequence as number,
      last_ledger_sequence: tx.LastLedgerSequence as number,
      destination: destination ?? "",
      amount: String((tx.Amount as { value?: string }).value),
    };
    try {
      fs.appendFileSync(signedPath, JSON.stringify(rec) + "\n");
    } catch (e) {
      const message = `could not record the signature in ${path.basename(signedPath)}: ${(e as Error).message}`;
      logLine({ decision_id, invoice_id, destination, result: "record_write_failed", message });
      return reply.code(500).send({ ok: false, error: "record_write_failed", message });
    }
    signed.push(rec);
    logLine({ decision_id, invoice_id, destination, result: "signed", sequence: rec.sequence, last_ledger_sequence: rec.last_ledger_sequence });
    return reply.send({ ok: true, signer: "cosigner", signer_address: wallet.address, signed_blob, checks });
  }),
);

const shutdown = () => {
  const c = client;
  Promise.allSettled([app.close(), c?.disconnect()]).finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app.listen({ port: PORT, host: HOST }).then(
  () =>
    console.log(
      `[cosigner] listening on http://${HOST}:${PORT} as ${wallet.address} (rule ${COSIGNER_RULE_VERSION}, AUTO_LIMIT ${AUTO_LIMIT} RLUSD, ` +
        `policy pinned: registry ${policy.registry.sha256.slice(0, 12)}, allowlist ${policy.allowlist.sha256.slice(0, 12)} (${allowlist.size} wallets), ` +
        `${signed.length} prior signatures, pid ${process.pid})`,
    ),
  (e) => {
    console.error(`[cosigner] failed to listen on ${HOST}:${PORT}: ${(e as Error).message}`);
    process.exit(1);
  },
);
