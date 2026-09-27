// Phase 4, Option B: the GOLDEN real organization on the xrpl side.
//
// Food Bank For New York City (EIN 13-3179546, Checkbook vendor 0000822784) is a real organization with real public
// records (Checkbook NYC contracts + payments, IRS 990 via ProPublica) that builder A ingests into Mongo. It has NOT
// onboarded with us: the XRPL wallet the agent pays for it (np_5) is a DEMO WALLET on XRPL Testnet whose key we hold
// (NP_5_SEED in xrpl/.env.local). Every place that shows it says so (GOLDEN_WALLET_LABEL).
//
// Shared Mongo contract with builder A (data/):
//   nonprofits {ein "13-3179546"}      A $sets the public fields; B (onboarding / seed-registry) $sets ONLY `wallet`.
//   contracts  {contract_id <golden>}  A $sets the public terms; B $sets ONLY xrpl_budget_rlusd + xrpl_budget_note.
//   demo_state {_id "golden"}          written by A: {golden_ein, golden_site_id, golden_contract_id, scale_usd_per_rlusd,
//                                      epoch, note, is_demo_data: true}. B only reads it.
//   payments                           A inserts Checkbook payments (source "checkbook"); the agent writes source "xrpl".
//                                      A's data/risk.py counts, for the golden contract only, released source-"xrpl"
//                                      payments dated at/after demo_state.epoch, times scale_usd_per_rlusd (DISCLOSED demo scale).
import type { Db } from "mongodb";

export const GOLDEN_EIN = "13-3179546";
export const GOLDEN_NAME = "Food Bank For New York City";
export const GOLDEN_CHECKBOOK_VENDOR = "0000822784";
/** Used only if builder A's demo_state is not written yet (the SNAP + emergency food assistance contract in Checkbook FY2026). */
export const GOLDEN_FALLBACK_CONTRACT_ID = "CT106920258801736";
export const GOLDEN_WALLET_LABEL = "demo wallet on XRPL Testnet; the real organization has not onboarded";
/** Testnet-scale budget B sets on the golden contract (xrpl_budget_rlusd) unless one is already set. */
export const GOLDEN_BUDGET_RLUSD = process.env.GOLDEN_BUDGET_RLUSD ?? "500.00";
export const DEMO_STATE_COLL = "demo_state";

export interface DemoState {
  _id: "golden";
  golden_ein: string;
  golden_site_id: string;
  golden_contract_id: string;
  scale_usd_per_rlusd: number;
  epoch: string;
  note: string;
  is_demo_data: true;
}

export async function readDemoState(db: Db): Promise<DemoState | null> {
  const d = await db.collection<DemoState>(DEMO_STATE_COLL).findOne({ _id: "golden" });
  return d && typeof d.golden_contract_id === "string" && d.golden_contract_id ? d : null;
}

/** Polls `fn` until it returns a non-null value or `timeoutMs` passes (0 = one try). */
export async function pollFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs: number, intervalMs = 30000, log: (m: string) => void = console.log): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() >= until) return null;
    log(`  waiting for ${label} (builder A) ... ${Math.ceil((until - Date.now()) / 60000)} min left`);
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(1000, until - Date.now()))));
  }
}

export function goldenBudgetNote(scale: number | null, budget: string, contractAmountUsd: string | null): string {
  const stands = scale && Number(budget) > 0 ? ` At the DISCLOSED demo scale (1 RLUSD = $${scale.toLocaleString("en-US")}; demo_state.scale_usd_per_rlusd) this budget stands for $${(Number(budget) * scale).toLocaleString("en-US")}` + (contractAmountUsd ? ` of the contract's real $${Number(contractAmountUsd).toLocaleString("en-US")}.` : ".") : "";
  return (
    `xrpl_budget_rlusd is a TESTNET-SCALE budget (set by xrpl/ seed-registry, is_demo_data) for the agent's XRPL Testnet demo payments under this REAL contract ` +
    `to the golden organization's DEMO wallet (np_5; ${GOLDEN_WALLET_LABEL}). The contract terms themselves are builder A's public record (if end_date_assumed is true, end_date is A's disclosed demo assumption: see end_date_note; the real end is end_date_loaded).` +
    stands +
    " The co-signer's within_contract_amount check compares on-ledger RLUSD paid under this contract with this number."
  );
}
