// Makes MongoDB agree with the local decision log and the ledger. Idempotent; holds no keys (root .env only).
//   1. backfill: every {decision, payment} in xrpl/data/decisions.local.jsonl whose decision_id is missing from Mongo
//      is inserted (the last log line per decision_id wins). This covers the Phase 1 payments, which were logged
//      locally before the Mongo recorder existed. Their decisions keep rule_version p1-allowlist-1; the checks the
//      Phase 1 co-signer did not run are added as {passed:false, detail:"not evaluated: ..."} so every decision carries
//      the 8 CHECK_NAMES. audit.backfilled_from records where the row came from.
//   2. settle: decisions refused with ledger_status_unknown (the agent lost contact before the final result) are
//      looked up on-ledger by xrpl_tx_hash and updated with the real result; the update is also appended to the log.
// Run: npm run reconcile -w xrpl   [-- --dry-run]
import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { paths } from "../src/env";
import { CHECK_NAMES, type Check, type Decision, type Payment } from "../../shared/contracts";
import { connect, explorerTx } from "../src/lib/xrpl";
import { decisionsLogPath } from "../src/lib/registry";
import { COLL, openMongo } from "../src/lib/mongo";

config({ path: path.join(paths.rootDir, ".env"), quiet: true });
const DRY = process.argv.includes("--dry-run");

type Line = { decision: Decision; payment: Payment | null; xrpl?: Record<string, unknown> };

function padChecks(d: Decision): Check[] {
  const have = new Map(d.checks.map((c) => [c.name, c]));
  const why = d.rule_version.startsWith("p1-") ? `the Phase 1 co-signer (rule ${d.rule_version}) did not run this check` : "this check was not recorded for this decision";
  return CHECK_NAMES.map((name) => have.get(name) ?? { name, passed: false, detail: `not evaluated: ${why}` });
}

async function main(): Promise<number> {
  const lines = fs.readFileSync(decisionsLogPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Line);
  const latest = new Map<string, Line>();
  for (const l of lines) latest.set(l.decision.decision_id, l);
  const m = await openMongo("divhacks-reconcile");
  try {
    const db = m.db;
    // 1. backfill
    const ids = [...latest.keys()];
    const inMongo = new Set((await db.collection(COLL.decisions).find({ decision_id: { $in: ids } }, { projection: { _id: 0, decision_id: 1 } }).toArray()).map((d) => String(d.decision_id)));
    const missing = [...latest.values()].filter((l) => !inMongo.has(l.decision.decision_id));
    const at = new Date().toISOString();
    let released = 0;
    for (const l of missing) {
      const d = { ...l.decision, checks: padChecks(l.decision) };
      if (d.outcome === "released") released++;
      console.log(`backfill ${d.decision_id}  ${d.rule_version}  ${d.outcome.padEnd(8)} ${d.amount} RLUSD  invoice ${d.invoice_id}${d.xrpl_tx_hash ? `  ${explorerTx(d.xrpl_tx_hash)}` : ""}`);
      if (DRY) continue;
      await db.collection(COLL.decisions).updateOne(
        { decision_id: d.decision_id },
        { $setOnInsert: { ...d, is_demo_data: true, audit: { ...(l.xrpl ?? {}), backfilled_from: "xrpl/data/decisions.local.jsonl", backfilled_at: at } } },
        { upsert: true },
      );
      if (l.payment) await db.collection(COLL.payments).updateOne({ payment_id: l.payment.payment_id }, { $setOnInsert: { ...l.payment } }, { upsert: true });
    }
    console.log(`backfill: ${missing.length} decision(s) were only in the local log (${released} released on-ledger)${DRY ? " [dry run: nothing written]" : "; inserted into Mongo"}`);

    // 2. settle ledger_status_unknown
    const unknown = await db.collection<Decision & { audit?: Record<string, unknown> }>(COLL.decisions).find({ refusal_reasons: "ledger_status_unknown", xrpl_tx_hash: { $ne: null } }, { projection: { _id: 0 } }).toArray();
    if (unknown.length) {
      const client = await connect();
      try {
        for (const d of unknown) {
          type TxR = { validated?: boolean; meta?: { TransactionResult: string }; close_time_iso?: string };
          let r: TxR | null = null;
          try {
            r = (await client.request({ command: "tx", transaction: d.xrpl_tx_hash! })).result as unknown as TxR;
          } catch (e) {
            console.log(`settle ${d.decision_id}: ${d.xrpl_tx_hash} not found yet (${(e as { data?: { error?: string } }).data?.error ?? (e as Error).message}); left as ledger_status_unknown`);
            continue;
          }
          if (!r?.validated || !r.meta) {
            console.log(`settle ${d.decision_id}: ${d.xrpl_tx_hash} is not validated yet; left as ledger_status_unknown`);
            continue;
          }
          const ok = r.meta.TransactionResult === "tesSUCCESS";
          const upd: Partial<Decision> = { outcome: ok ? "released" : "refused", refusal_reasons: ok ? [] : ["ledger_rejected"], enforced_by: ok ? null : "ledger", ledger_result: r.meta.TransactionResult };
          console.log(`settle ${d.decision_id}: ${r.meta.TransactionResult} -> ${upd.outcome}  ${explorerTx(d.xrpl_tx_hash!)}`);
          if (DRY) continue;
          await db.collection(COLL.decisions).updateOne({ decision_id: d.decision_id }, { $set: { ...upd, "audit.reconciled_at": at } });
          const payment_id = `pay_${d.decision_id.replace(/^dec_/, "")}`;
          await db.collection(COLL.payments).updateOne({ payment_id }, { $set: { status: upd.outcome, ...(r.close_time_iso ? { date: r.close_time_iso } : {}) } });
          const p = await db.collection<Payment>(COLL.payments).findOne({ payment_id }, { projection: { _id: 0 } });
          const { audit: _a, ...plain } = d;
          fs.appendFileSync(decisionsLogPath, JSON.stringify({ decision: { ...plain, ...upd }, payment: p, xrpl: { reconciled_at: at, final_result: r.meta.TransactionResult } }) + "\n");
        }
      } finally {
        await client.disconnect().catch(() => undefined);
      }
    }
    console.log(`settle: ${unknown.length} decision(s) with ledger_status_unknown examined`);
    return 0;
  } finally {
    await m.close();
  }
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error("reconcile failed:", e instanceof Error ? e.message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>") : e);
    process.exit(1);
  },
);
