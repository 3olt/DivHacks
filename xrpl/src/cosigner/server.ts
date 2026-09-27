// Compliance co-signer: a SEPARATE process with its own key (weight 2 on agent_account's signer list).
// It loads ONLY the root .env + xrpl/.env.cosigner, holds only COSIGNER_SEED, and never receives LLM text:
// it decodes the transaction it is asked to sign, runs its 8 checks (./checks.ts) against its OWN sources of truth,
// and either co-signs that exact transaction or refuses (HTTP 422) without signing.
//
// What it trusts, and where it comes from:
//   - file policy (accounts.testnet.json, allowlist.json, exclusions.json): read ONCE at startup, pinned by SHA-256;
//     later edits on disk are ignored (and reported in /health) until a restart.
//   - payee registry (Mongo `nonprofits` with a wallet): snapshot read ONCE at startup, pinned by SHA-256 (logged).
//     It refuses to START if that snapshot disagrees with the pinned accounts.testnet.json for any EIN, or holds a
//     wallet that is not on the pinned allowlist. Every /cosign re-reads it and refuses with registry_drift if it
//     changed (the agent has the same DB credentials in this hackathon setup; production gives the co-signer a DB
//     user the agent cannot write).
//   - contract terms (Mongo `contracts`): pinned at startup too (lib/contractPins.ts); a later change -> registry_drift,
//     a contract created later is admitted only as a small demo contract. It never reads `decisions`.
//   - AUTO_LIMIT, DAILY_CAP, PAYEE_DAILY_CAP, MONGODB_URI/DB, XRPL_WS, RLUSD_*, AGENT_SOURCE_TAG: ONLY from the root
//     .env FILE, read once at startup; values inherited from the process that started it are discarded (env.ts). For
//     tests, COSIGNER_TEST_AUTO_LIMIT / COSIGNER_TEST_DAILY_CAP / COSIGNER_TEST_PAYEE_DAILY_CAP can only LOWER a limit.
//   - ledger state: its OWN XRPL connection (agent_account Sequence, validated ledger, full account_tx history).
//   - what it already signed: its own append-only record xrpl/data/cosigner-signed.local.jsonl (written BEFORE a
//     signature is returned; if the write fails, no signature leaves the process).
//   - City Credentials (check 1, Phase 3): read ON-LEDGER per request (ledger_entry, issuer = pinned city_issuer).
//   - payee change holds (Phase 3): its own sticky, append-only record xrpl/data/cosigner-holds.local.jsonl of every hold it
//     has seen in Mongo `payee_change_requests` (re-read every 5 s and on every /cosign). A hold is lifted only by an
//     officer-signed resolution it verifies itself (lib/holds.ts); deleting or editing the database copy does not lift it.
//
//   GET  /health  -> {ok, role:"cosigner", signer_address, rule_version, allowlist_size, auto_limit, caps, policy, registry, signed_count}
//   POST /cosign  {tx_blob, invoice_id, decision_id}
//        200 {ok:true, signer:"cosigner", signer_address, signed_blob, checks}      (all 8 passed)
//        422 {ok:false, refusal_reasons, checks}          (all 8 evaluated; nothing signed)
//        400 {ok:false, error:"bad_request", message}     (malformed request; nothing signed)
//        503 {ok:false, error:"ledger_unavailable"|"registry_unavailable", message}  (could not read its sources; nothing signed)
//        500 {ok:false, error:"record_write_failed", message} (could not record the signature; nothing returned)
//   GET  /holds               -> {ok, holds:[...every hold it has seen, with its verified resolution], active:[...]}
//   POST /holds/refresh       -> re-reads payee_change_requests now (the xrpl service calls it after creating a hold)
//   POST /holds/resolution {resolution: PayeeChangeResolution}
//        200 {ok:true, request_id, active}      (officer signature verified; recorded)
//        422 {ok:false, error:"resolution_rejected", message}
//   GET  /over-limit/:decision_id -> {ok, decision_id, refusals:[{ts, invoice_id, amount, destination, contract_id, payee_ein,
//        dh, memo_sha256, sequence}]} what the co-signer saw when it refused that decision ONLY with over_auto_limit_needs_officer
//        (its own record xrpl/data/cosigner-overlimit.local.jsonl); the officer checks pending approvals against it. 404 if none.
//   Phase 3, builder B (./extraRoutes.ts): POST /governance/cosign (kill switch SignerListSet REVOKED/CANONICAL, CTT trust
//   line), POST /escrow/condition, POST /escrow/cosign, POST /escrow/release-approval (officer), POST /escrow/finish,
//   GET /escrow (SIMULATED escrow: CTT test token)
//
// Run: npm run cosigner   (repo root or xrpl/)
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { Wallet, decode, hashes, multisign, type Client, type Transaction } from "xrpl";
import { discardedInheritedPolicyKeys, loadEnv, paths } from "../env";
import { readPinnedPolicy, sha256File } from "../lib/registry";
import { connect, rlusd, sourceTag } from "../lib/xrpl";
import { mongoDbName, openMongo, type MongoHandle } from "../lib/mongo";
import { ContractPins } from "../lib/contractPins";
import { readRegistrySnapshot, type RegistrySnapshot } from "../lib/registrySnapshot";
import { decodePaymentMemo } from "../lib/ledgerScan";
import { runChecks, COSIGNER_RULE_VERSION, type SignedRecord } from "./checks";
import { gatherContext, policyFromEnv, type PolicyInputs } from "./context";
import { HoldBook } from "../lib/holds";
import { registerExtraRoutes } from "./extraRoutes";
import { GOVERNANCE_RULE_VERSION } from "../lib/governance";
import { ESCROW_RULE_VERSION, SIMULATED_ESCROW_LABEL } from "../lib/escrow";
import { sha256Hex } from "../../../shared/hash";

loadEnv("cosigner");

function die(msg: string): never {
  console.error(`[cosigner] ${msg}`);
  process.exit(1);
}

// Key isolation: this process must hold exactly one seed, its own.
const foreign = Object.keys(process.env).filter((k) => k.endsWith("_SEED") && k !== "COSIGNER_SEED");
if (foreign.length) die(`refusing to start: other signing seeds are present in this process's environment (${foreign.join(", ")})`);
const seed = process.env.COSIGNER_SEED;
if (!seed) die('COSIGNER_SEED missing: run "npm run setup:xrpl" to generate xrpl/.env.cosigner');
const wallet = Wallet.fromSeed(seed);
delete process.env.COSIGNER_SEED;

// File policy pinned at startup.
const filePolicy = readPinnedPolicy();
const registryFile = filePolicy.registry.data;
const pinnedAt = new Date().toISOString();
if (registryFile.signers.cosigner.address !== wallet.address) die(`COSIGNER_SEED derives ${wallet.address}, but the registry's cosigner is ${registryFile.signers.cosigner.address}; refusing to start`);
const RL = rlusd();
if (registryFile.rlusd.issuer !== RL.issuer || registryFile.rlusd.currency !== RL.currency) die("RLUSD issuer/currency in the root .env differ from the registry; refusing to start");

let policy: PolicyInputs;
try {
  policy = policyFromEnv({
    agentAccount: registryFile.agent_account,
    credentialIssuer: registryFile.city_issuer,
    signerAddresses: { agent: registryFile.signers.agent.address, officer: registryFile.signers.officer.address },
    allowlist: new Set(filePolicy.allowlist.data.addresses),
    exclusions: new Map(filePolicy.exclusions.data.entries.map((e) => [e.ein, e])),
    exclusionsSha256: filePolicy.exclusions.sha256,
    rlusd: RL,
    sourceTag: sourceTag(),
  });
} catch (e) {
  die(`bad policy config: ${(e as Error).message}`);
}

// Test-only overrides that can only TIGHTEN a limit (a looser value is ignored), so whoever starts the co-signer
// cannot use them to let more money out. Reported in /health.
const testTightened: string[] = [];
for (const [envKey, field] of [["COSIGNER_TEST_AUTO_LIMIT", "autoLimit"], ["COSIGNER_TEST_DAILY_CAP", "dailyCap"], ["COSIGNER_TEST_PAYEE_DAILY_CAP", "payeeDailyCap"]] as const) {
  const raw = process.env[envKey];
  if (raw === undefined) continue;
  const v = Number(raw);
  if (v > 0 && v < policy[field]) {
    testTightened.push(`${field} ${policy[field]} -> ${v}`);
    policy[field] = v;
  } else {
    console.log(`[cosigner] ignoring ${envKey}=${raw}: test overrides may only lower the limit (${field} stays ${policy[field]})`);
  }
}
if (discardedInheritedPolicyKeys.length) {
  console.log(`[cosigner] discarded inherited values for ${discardedInheritedPolicyKeys.join(", ")}: policy comes only from the root .env file`);
}

// The co-signer's own signing record.
const signedPath = path.join(paths.dataDir, "cosigner-signed.local.jsonl");
const signed: SignedRecord[] = fs.existsSync(signedPath)
  ? fs.readFileSync(signedPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as SignedRecord)
  : [];

// The co-signer's own record of the over-limit payments it refused ONLY with over_auto_limit_needs_officer (check 5):
// what it saw for each decision_id (amount, destination, memo dh). The officer compares a pending approval with THIS
// record (GET /over-limit/:decision_id), a source the agent cannot write, before it approves anything.
interface OverLimitRecord {
  ts: string;
  decision_id: string;
  invoice_id: string;
  destination: string;
  amount: string;
  contract_id: string | null;
  payee_ein: string | null;
  dh: string | null;
  memo_sha256: string | null;
  sequence: number;
}
const overLimitPath = path.join(paths.dataDir, "cosigner-overlimit.local.jsonl");
const overLimit = new Map<string, OverLimitRecord[]>();
if (fs.existsSync(overLimitPath)) {
  for (const l of fs.readFileSync(overLimitPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const r = JSON.parse(l) as OverLimitRecord;
      overLimit.set(r.decision_id, [...(overLimit.get(r.decision_id) ?? []), r]);
    } catch {
      /* skip unreadable line */
    }
  }
}

// The co-signer's own sticky record of payee change holds (never configurable from the environment).
const holdsPath = path.join(paths.dataDir, "cosigner-holds.local.jsonl");
const holdBook = new HoldBook(holdsPath, registryFile.signers.officer.address);
if (holdBook.problems.length) console.log(`[cosigner] hold record: ${holdBook.problems.length} unreadable line(s) ignored`);
const HOLD_POLL_MS = 5000;

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

function fileDrift() {
  const same = (p: string, h: string) => {
    try {
      return sha256File(p) === h;
    } catch {
      return false;
    }
  };
  return {
    registry_on_disk_matches: same(filePolicy.registry.path, filePolicy.registry.sha256),
    allowlist_on_disk_matches: same(filePolicy.allowlist.path, filePolicy.allowlist.sha256),
    exclusions_on_disk_matches: same(filePolicy.exclusions.path, filePolicy.exclusions.sha256),
  };
}

// Own XRPL connection (lazy, reconnects if it drops).
let client: Client | null = null;
async function xrplClient(): Promise<Client> {
  if (!client || !client.isConnected()) {
    if (client) await client.disconnect().catch(() => undefined);
    client = await connect();
  }
  return client;
}

// One /cosign at a time, so two concurrent requests cannot both pass the "not signed / not paid" checks.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function main() {
  // Registry snapshot pinned at startup (Mongo). No database -> no co-signer.
  let mongo: MongoHandle;
  let pinned: RegistrySnapshot;
  try {
    mongo = await openMongo("divhacks-cosigner");
    pinned = await readRegistrySnapshot(mongo.db);
  } catch (e) {
    die(`cannot read the payee registry from MongoDB (${(e as Error).message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>")}); refusing to start`);
  }
  if (pinned.entries.length === 0) die('the nonprofits registry in MongoDB has no wallets; run "npm run seed:registry" first');
  // The database registry must agree with the committed accounts.testnet.json (pinned above) for every EIN, and may not
  // hold wallets outside the pinned allowlist. Otherwise refuse to start: a swap made while the co-signer was stopped
  // would otherwise be pinned as if it were legitimate.
  const mismatched = Object.values(registryFile.nonprofits).filter((np) => pinned.byEin.get(np.ein)?.address !== np.address);
  if (mismatched.length) {
    die(
      `refusing to start: the payee registry in MongoDB disagrees with accounts.testnet.json for EIN ${mismatched.map((n) => `${n.ein} (file ${n.address}, database ${pinned.byEin.get(n.ein)?.address ?? "none"})`).join(", ")}; ` +
        'restore it with "npm run seed:registry" and review how it changed',
    );
  }
  const unlisted = pinned.entries.filter((e) => !policy.allowlist.has(e.address));
  if (unlisted.length) die(`refusing to start: the payee registry in MongoDB has wallets that are not on the pinned allowlist: ${unlisted.map((e) => `${e.ein} ${e.address}`).join(", ")}`);
  // Contract terms pinned at startup (payee EIN, testnet budget, term dates).
  let contracts: ContractPins;
  try {
    contracts = await ContractPins.load(mongo.db);
  } catch (e) {
    die(`cannot read the contracts from MongoDB (${(e as Error).message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>")}); refusing to start`);
  }
  const resolveContract = contracts.resolver(mongo.db, new Set(pinned.entries.map((e) => e.ein)));

  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  // Phase 3, builder B: governance (kill switch, CTT trust line) + SIMULATED escrow routes (./extraRoutes.ts).
  const extra = registerExtraRoutes({ app, wallet, policy, registryFile, pinned, resolveContract, holdBook, db: mongo.db, xrplClient, serial, logLine });

  app.get("/health", async () => ({
    ok: true,
    role: "cosigner",
    signer_address: wallet.address,
    rule_version: COSIGNER_RULE_VERSION,
    allowlist_size: policy.allowlist.size,
    auto_limit: policy.autoLimit,
    caps: { daily_cap: policy.dailyCap, payee_daily_cap: policy.payeeDailyCap },
    policy: {
      source: "root .env file (inherited values discarded)",
      discarded_inherited_keys: discardedInheritedPolicyKeys,
      test_tightened: testTightened,
      mongodb_db: mongoDbName(),
      pinned_at: pinnedAt,
      registry_sha256: filePolicy.registry.sha256,
      allowlist_sha256: filePolicy.allowlist.sha256,
      exclusions_sha256: filePolicy.exclusions.sha256,
      ...fileDrift(),
    },
    registry: { source: "mongo nonprofits (wallets)", pinned_sha256: pinned.sha256, pinned_at: pinned.read_at, wallets: pinned.entries.length },
    contracts: { source: "mongo contracts (terms pinned at startup)", pinned_sha256: contracts.sha256, pinned_at: contracts.read_at, pinned: contracts.count, late_admitted: contracts.lateAdmitted },
    signed_count: signed.length,
    credentials: { source: "on-ledger ledger_entry (validated ledger)", issuer: policy.credentialIssuer, type: "NYC_VERIFIED_NONPROFIT" },
    holds: { source: "own sticky record + mongo payee_change_requests; lifted only by a verified officer signature", known: holdBook.size, active: holdBook.active(Date.now(), (e) => pinned.byEin.get(e)?.address).length },
    // Phase 3, builder B: kill switch / CTT trust line (POST /governance/cosign) and the SIMULATED escrow (/escrow/*).
    governance: { rule_version: GOVERNANCE_RULE_VERSION, accepts: "SignerListSet to exactly REVOKED {cosigner:2, officer:1} or CANONICAL {agent:1, cosigner:2, officer:1} (officer-signed); TrustSet for exactly CTT/city_issuer" },
    escrow: { rule_version: ESCROW_RULE_VERSION, label: SIMULATED_ESCROW_LABEL, milestones: extra.escrowBook.conditions.size },
  }));

  const activeHolds = () => holdBook.active(Date.now(), (e) => pinned.byEin.get(e)?.address);
  app.get("/holds", async () => ({ ok: true, holds: holdBook.list(), active: activeHolds() }));
  app.get("/over-limit/:decision_id", async (req, reply) => {
    const { decision_id } = req.params as { decision_id: string };
    if (!ID_RE.test(decision_id)) return reply.code(400).send({ ok: false, error: "bad_request", message: "bad decision_id" });
    const refusals = overLimit.get(decision_id);
    if (!refusals?.length) return reply.code(404).send({ ok: false, error: "not_found", message: `the co-signer never refused decision ${decision_id} with only over_auto_limit_needs_officer` });
    return { ok: true, decision_id, refusals };
  });
  app.post("/holds/refresh", (_req, reply) =>
    serial(async () => {
      try {
        await holdBook.refresh(mongo.db);
      } catch (e) {
        return reply.code(503).send({ ok: false, error: "registry_unavailable", message: (e as Error).message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>") });
      }
      return reply.send({ ok: true, known: holdBook.size, active: activeHolds() });
    }),
  );
  app.post("/holds/resolution", (req, reply) =>
    serial(async () => {
      const body = req.body as { resolution?: unknown } | null;
      try {
        await holdBook.refresh(mongo.db); // the hold must be known before a resolution can apply to it
      } catch {
        /* a directly delivered resolution can still be verified against an already-recorded hold */
      }
      const v = holdBook.accept(body?.resolution);
      logLine({ holds: "resolution", request_id: v.request_id ?? null, result: v.ok ? "accepted" : "rejected", why: v.why });
      if (!v.ok) return reply.code(422).send({ ok: false, error: "resolution_rejected", message: v.why });
      return reply.send({ ok: true, request_id: v.request_id, note: v.why, active: activeHolds() });
    }),
  );

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
      const destination = typeof tx.Destination === "string" ? tx.Destination : null;

      const drift = fileDrift();
      if (!drift.registry_on_disk_matches || !drift.allowlist_on_disk_matches || !drift.exclusions_on_disk_matches) {
        logLine({ warning: "policy files changed on disk since startup; still using the pinned copy (restart the co-signer to adopt them)", ...drift });
      }

      let ctx;
      try {
        ctx = await gatherContext(tx, invoice_id, { client: await xrplClient(), db: mongo.db, policy, pinned, contracts: resolveContract, signed, requireSignatures: true, holdBook });
      } catch (e) {
        const msg = (e as Error).message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>");
        const isMongo = /mongo|topology|server selection/i.test(msg) || (e as { name?: string }).name?.startsWith("Mongo");
        const error = isMongo ? "registry_unavailable" : "ledger_unavailable";
        const message = `could not read its sources of truth (${isMongo ? "MongoDB registry/contracts" : "XRPL ledger"}): ${msg}`;
        logLine({ decision_id, invoice_id, destination, result: error, message });
        return reply.code(503).send({ ok: false, error, message });
      }

      const { checks, refusal_reasons } = runChecks(tx, ctx);
      if (refusal_reasons.length > 0 || checks.some((c) => !c.passed)) {
        const failed = checks.filter((c) => !c.passed).map((c) => c.name);
        logLine({ decision_id, invoice_id, destination, result: "refused", refusal_reasons, failed });
        if (refusal_reasons.join() === "over_auto_limit_needs_officer" && failed.join() === "within_auto_limit_or_officer_signed") {
          // Record what it saw, so the officer can check a pending approval against the co-signer rather than the agent.
          const m = decodePaymentMemo(tx.Memos as never);
          const memoData = (tx.Memos as { Memo?: { MemoData?: string } }[] | undefined)?.[0]?.Memo?.MemoData;
          const r: OverLimitRecord = {
            ts: new Date().toISOString(), decision_id, invoice_id, destination: destination ?? "", amount: String((tx.Amount as { value?: string }).value),
            contract_id: m?.ctr ?? null, payee_ein: m?.ein ?? null, dh: m?.dh ?? null,
            memo_sha256: memoData ? sha256Hex(Buffer.from(memoData, "hex").toString("utf8")) : null, sequence: tx.Sequence as number,
          };
          try {
            fs.appendFileSync(overLimitPath, JSON.stringify(r) + "\n");
            overLimit.set(decision_id, [...(overLimit.get(decision_id) ?? []), r]);
          } catch (e) {
            logLine({ decision_id, warning: `could not record the over-limit refusal (${(e as Error).message}); the officer will not be able to approve it` });
          }
        }
        return reply.code(422).send({ ok: false, refusal_reasons, checks });
      }

      // Sign the SAME transaction that was checked: strip the agent's Signers and add our multisig signature.
      const txJson = { ...tx };
      delete txJson.Signers;
      let signed_blob: string;
      let tx_hash: string | undefined;
      try {
        signed_blob = wallet.sign(txJson as unknown as Transaction, true).tx_blob;
        tx_hash = hashes.hashSignedTx(multisign([tx_blob, signed_blob]));
      } catch (e) {
        return bad(`transaction failed validation: ${(e as Error).message}`);
      }

      // Record BEFORE the signature leaves this process.
      const recMemo = decodePaymentMemo(tx.Memos as never);
      const rec: SignedRecord = {
        ts: new Date().toISOString(),
        invoice_id,
        decision_id,
        sequence: tx.Sequence as number,
        last_ledger_sequence: tx.LastLedgerSequence as number,
        destination: destination ?? "",
        amount: String((tx.Amount as { value?: string }).value),
        contract_id: recMemo?.ctr,
        payee_ein: recMemo?.ein,
        tx_hash,
      };
      try {
        fs.appendFileSync(signedPath, JSON.stringify(rec) + "\n");
      } catch (e) {
        const message = `could not record the signature in ${path.basename(signedPath)}: ${(e as Error).message}`;
        logLine({ decision_id, invoice_id, destination, result: "record_write_failed", message });
        return reply.code(500).send({ ok: false, error: "record_write_failed", message });
      }
      signed.push(rec);
      logLine({ decision_id, invoice_id, destination, result: "signed", sequence: rec.sequence, last_ledger_sequence: rec.last_ledger_sequence, tx_hash });
      return reply.send({ ok: true, signer: "cosigner", signer_address: wallet.address, signed_blob, checks });
    }),
  );

  // Record new holds within seconds of their creation, so deleting one quickly does not help a compromised agent.
  const poll = setInterval(() => {
    serial(() => holdBook.refresh(mongo.db)).catch((e) => logLine({ holds: "refresh_failed", message: (e as Error).message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>").slice(0, 160) }));
  }, HOLD_POLL_MS);
  poll.unref();
  try {
    await holdBook.refresh(mongo.db);
  } catch (e) {
    die(`cannot read payee_change_requests from MongoDB (${(e as Error).message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>")}); refusing to start`);
  }

  const shutdown = () => {
    clearInterval(poll);
    const c = client;
    Promise.allSettled([app.close(), c?.disconnect(), mongo.close()]).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (e) {
    await mongo.close().catch(() => undefined);
    die(`failed to listen on ${HOST}:${PORT}: ${(e as Error).message}`);
  }
  console.log(
    `[cosigner] listening on http://${HOST}:${PORT} as ${wallet.address} (rule ${COSIGNER_RULE_VERSION}, AUTO_LIMIT ${policy.autoLimit}, ` +
      `DAILY_CAP ${policy.dailyCap}, PAYEE_DAILY_CAP ${policy.payeeDailyCap} RLUSD, pid ${process.pid})`,
  );
  console.log(
    `[cosigner] pinned policy: accounts ${filePolicy.registry.sha256.slice(0, 12)}, allowlist ${filePolicy.allowlist.sha256.slice(0, 12)} (${policy.allowlist.size} wallets), ` +
      `exclusions ${filePolicy.exclusions.sha256.slice(0, 12)} (${policy.exclusions.size} entries); registry snapshot (Mongo nonprofits) sha256 ${pinned.sha256} ` +
      `(${pinned.entries.length} wallets); contract terms sha256 ${contracts.sha256.slice(0, 12)} (${contracts.count} contracts); ${signed.length} prior signatures`,
  );
  console.log(`[cosigner] credentials: read on-ledger (issuer city_issuer ${policy.credentialIssuer}); holds: ${holdBook.size} known, ${activeHolds().length} in force (${path.relative(paths.rootDir, holdsPath)})`);
  if (testTightened.length) console.log(`[cosigner] TEST MODE: limits tightened by COSIGNER_TEST_* (${testTightened.join(", ")})`);
}

main().catch((e) => die(`startup failed: ${(e as Error).message}`));
