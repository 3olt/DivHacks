// Persists every payment attempt (AGENT process): a Decision and a Payment (source "xrpl") to MongoDB, plus the
// local JSONL backup xrpl/data/decisions.local.jsonl ({decision, payment, xrpl: audit}, the format scripts/verify.ts reads).
// Extra audit data (destination, delivered_amount, proposal, co-signer HTTP status, ...) goes under decisions.audit.
// Optional: NOTIFY_API=1 POSTs {decision_id, decision} to API_URL/events/payment after each decision (failures ignored).
import fs from "node:fs";
import type { Db } from "mongodb";
import type { Decision, Payment } from "../../../shared/contracts";
import { decisionsLogPath } from "../lib/registry";
import { COLL } from "../lib/mongo";

export interface RecordResult {
  mongo: "written" | "skipped (no database)" | `FAILED: ${string}`;
  notified: "off" | "sent" | `failed: ${string}`;
}

export class Recorder {
  constructor(private db: Db | null) {}

  async record(decision: Decision, payment: Payment, audit: Record<string, unknown>): Promise<RecordResult> {
    fs.appendFileSync(decisionsLogPath, JSON.stringify({ decision, payment, xrpl: audit }) + "\n");
    let mongo: RecordResult["mongo"] = "skipped (no database)";
    if (this.db) {
      try {
        await this.db.collection(COLL.decisions).replaceOne({ decision_id: decision.decision_id }, { ...decision, is_demo_data: true, audit }, { upsert: true });
        await this.db.collection(COLL.payments).replaceOne({ payment_id: payment.payment_id }, { ...payment }, { upsert: true });
        mongo = "written";
      } catch (e) {
        mongo = `FAILED: ${(e as Error).message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>").slice(0, 200)}`;
      }
    }
    let notified: RecordResult["notified"] = "off";
    if (/^(1|true|yes)$/i.test(process.env.NOTIFY_API ?? "")) {
      const url = `${(process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "")}/events/payment`;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision_id: decision.decision_id, decision }),
          signal: AbortSignal.timeout(5000),
        });
        notified = r.ok ? "sent" : `failed: HTTP ${r.status}`;
      } catch (e) {
        notified = `failed: ${(e as Error).message}`;
      }
    }
    return { mongo, notified };
  }
}
