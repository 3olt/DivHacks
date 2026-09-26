// ============================================================================
// PLACEHOLDER — SIMULATED ESCROW. REMOVE when xrpl/ implements real escrow.
// ============================================================================
// RLUSD escrow fails on Testnet (tecNO_PERMISSION; see docs/RISK_CHECKS.md #3), so this fakes the
// escrow flow for the demo UI: POST /demo/escrow locks a milestone (outcome "held_escrow"), and
// POST /demo/escrow-release finishes it (outcome "released", flips the golden pin like "happy").
// Nothing touches the XRP Ledger. The plan for the real version is a city-issued test token escrow
// (EscrowCreate with PREIMAGE-SHA-256 + CancelAfter, then EscrowFinish), proven in RISK_CHECKS #3b.
//
// To remove: delete this file, the PLACEHOLDER block in api/src/routes/demo.ts, the PLACEHOLDER
// exception in api/src/fixtures/decisionFactory.ts, and the escrow entries in web/src/lib/api.ts.
// These scenarios are deliberately NOT in SCENARIOS (api/src/demo/scenarios.ts), so the smoke test is unchanged.
import type { Decision } from "../../../shared/contracts";
import { makeDecision } from "../fixtures/decisionFactory";
import { fakeTxHash } from "../lib/hash";
import { nowNY } from "../lib/time";
import type { Risk } from "../risk";
import type { DataStore, StoreMode } from "../store";

export const ESCROW_PLACEHOLDER_SCENARIOS = ["escrow", "escrow-release"] as const;
export type EscrowPlaceholderScenario = (typeof ESCROW_PLACEHOLDER_SCENARIOS)[number];

export const isEscrowPlaceholderScenario = (s: string): s is EscrowPlaceholderScenario =>
  (ESCROW_PLACEHOLDER_SCENARIOS as readonly string[]).includes(s);

const GOLD_CONTRACT = "CT1-069-20261409087";
const MILESTONE_AMOUNT = 9; // testnet-scale: under AUTO_LIMIT (25) and DAILY_CAP (100)

export async function runEscrowPlaceholder(
  store: DataStore,
  scenario: EscrowPlaceholderScenario,
): Promise<{ scenario: EscrowPlaceholderScenario; mode: StoreMode; decision: Decision; site_updated?: { site_id: string; risk: Risk } }> {
  const seq = await store.nextDemoSeq();
  const created_at = nowNY();
  const history = await store.listDecisions(10_000);
  const invoice_id = `INV-2026-E${String(seq).padStart(3, "0")}`;
  const base = {
    decision_id: `fx_demo_${scenario}_${String(seq).padStart(4, "0")}`,
    created_at,
    invoice_id,
    contract_id: GOLD_CONTRACT,
    amount: MILESTONE_AMOUNT,
    enforced_by: null,
    refusal_reasons: [],
    signers: ["agent", "cosigner"] as ("agent" | "cosigner")[],
    xrpl_tx_hash: fakeTxHash(0xe000 + seq),
    ledger_result: "tesSUCCESS",
  };

  const decision =
    scenario === "escrow"
      ? makeDecision(
          {
            ...base,
            outcome: "held_escrow",
            agent_reasoning: `SIMULATED ESCROW (placeholder, test token, not RLUSD): milestone invoice ${invoice_id} for October pantry deliveries under ${GOLD_CONTRACT}. EscrowCreate locks 9.00 until the co-signer confirms delivery (PREIMAGE-SHA-256 condition); returns to the city after CancelAfter (7 days).`,
          },
          history,
        )
      : makeDecision(
          {
            ...base,
            outcome: "released",
            agent_reasoning: `SIMULATED ESCROW (placeholder, test token, not RLUSD): milestone confirmed; the co-signer fulfilled the condition and EscrowFinish released 9.00 for invoice ${invoice_id} under ${GOLD_CONTRACT}.`,
          },
          history,
        );

  await store.upsertDecision(decision);
  const result: { scenario: EscrowPlaceholderScenario; mode: StoreMode; decision: Decision; site_updated?: { site_id: string; risk: Risk } } = {
    scenario,
    mode: store.mode,
    decision,
  };
  if (decision.outcome === "released") {
    const site = await store.findSiteForDecision(decision);
    const risk = site ? await store.applyRelease(site.id, decision) : null;
    if (site && risk) result.site_updated = { site_id: site.id, risk };
  }
  return result;
}
