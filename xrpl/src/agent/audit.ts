// Agent-side AUDIT of a transaction the co-signer never saw (the builder stopped it first, or a simulated compromised
// agent skipped the co-signer). It runs the co-signer's published pure checks (../cosigner/checks.ts) over the agent's own
// fresh reads (ledger + Mongo), so every Decision carries all 8 checks. This is RECORD-KEEPING only: enforcement is done
// by the co-signer (separate process + key) and by the ledger's quorum, never by this function.
import type { Client } from "xrpl";
import type { Db } from "mongodb";
import type { Check, RefusalCode } from "../../../shared/contracts";
import { loadAllowlist, loadExclusions, sha256File, exclusionsPath, type Registry } from "../lib/registry";
import { rlusd, sourceTag } from "../lib/xrpl";
import { runChecks, notEvaluatedChecks } from "../cosigner/checks";
import { gatherContext, policyFromEnv, type PolicyInputs } from "../cosigner/context";
import { liveContractResolver } from "../lib/contractPins";

export function agentPolicy(reg: Registry): PolicyInputs {
  const ex = loadExclusions();
  return policyFromEnv({
    agentAccount: reg.agent_account,
    signerAddresses: { agent: reg.signers.agent.address, officer: reg.signers.officer.address },
    allowlist: new Set(loadAllowlist().addresses),
    exclusions: new Map(ex.entries.map((e) => [e.ein, e])),
    exclusionsSha256: sha256File(exclusionsPath),
    rlusd: rlusd(),
    sourceTag: sourceTag(),
  });
}

export async function agentAudit(
  tx: Record<string, unknown>,
  invoiceId: string,
  deps: { client: Client; db: Db | null; reg: Registry },
  label: string,
): Promise<{ checks: Check[]; refusal_reasons: RefusalCode[] }> {
  if (!deps.db) return { checks: notEvaluatedChecks(`${label}; no database connection for the audit`), refusal_reasons: [] };
  try {
    const ctx = await gatherContext(tx, invoiceId, {
      client: deps.client, db: deps.db, policy: agentPolicy(deps.reg), pinned: null, contracts: liveContractResolver(deps.db), signed: [], requireSignatures: false,
    });
    const r = runChecks(tx, ctx);
    return { checks: r.checks.map((c) => ({ ...c, detail: `[agent-side audit: ${label}] ${c.detail}` })), refusal_reasons: r.refusal_reasons };
  } catch (e) {
    return { checks: notEvaluatedChecks(`${label}; audit could not read the ledger/database (${(e as Error).message.slice(0, 120)})`), refusal_reasons: [] };
  }
}
