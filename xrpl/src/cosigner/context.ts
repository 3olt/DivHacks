// Gathers the facts runChecks() needs, from the caller's OWN sources: its XRPL connection (account_info, validated
// ledger index + close time, the Destination's NYC_VERIFIED_NONPROFIT credential via ledger_entry, agent_account's full
// account_tx history) and MongoDB (contract terms via a resolver; nonprofits registry snapshot; payee change requests,
// filtered through the caller's HoldBook, so only an officer-signed resolution lifts a hold). Used by the co-signer for every /cosign (registry snapshot + contract terms pinned at startup, see
// lib/contractPins.ts), and by the agent process for its own audit record when it stops a payment before the co-signer
// is asked (live reads, no pins).
// It NEVER reads the decisions collection or anything the agent wrote.
import type { Client } from "xrpl";
import type { Db } from "mongodb";
import { decodePaymentMemo, scanAgentHistory } from "../lib/ledgerScan";
import type { ContractResolver } from "../lib/contractPins";
import { readRegistrySnapshot, type RegistrySnapshot } from "../lib/registrySnapshot";
import type { ExclusionEntry } from "../lib/registry";
import type { CheckContext, LedgerView, SignedRecord } from "./checks";
import { readCredential, validatedLedger } from "../lib/credentials";
import type { HoldBook } from "../lib/holds";

export interface PolicyInputs {
  agentAccount: string;
  /** city_issuer from accounts.testnet.json (pinned by the co-signer). */
  credentialIssuer: string;
  signerAddresses: { agent: string; officer: string };
  allowlist: Set<string>;
  exclusions: Map<string, ExclusionEntry>;
  exclusionsSha256: string;
  rlusd: { currency: string; issuer: string };
  sourceTag: number;
  autoLimit: number;
  dailyCap: number;
  payeeDailyCap: number;
}

export async function readLedgerView(client: Client, agentAccount: string): Promise<LedgerView & { closeTime: number }> {
  const info = await client.request({ command: "account_info", account: agentAccount, ledger_index: "current" });
  const v = await validatedLedger(client);
  return { accountSequence: info.result.account_data.Sequence, validatedLedger: v.ledger_index, closeTime: v.close_time };
}

/**
 * @param pinned the registry snapshot pinned at startup (co-signer). If null, the fresh read is used and no drift is
 *               possible (agent-side audit).
 * @param signed the co-signer's own signing record ([] for the agent audit).
 */
export async function gatherContext(
  tx: Record<string, unknown>,
  invoiceId: string,
  deps: {
    client: Client;
    db: Db;
    policy: PolicyInputs;
    pinned: RegistrySnapshot | null;
    /** Contract terms: pinned (co-signer) or live (agent audit). */
    contracts: ContractResolver;
    signed: readonly SignedRecord[];
    requireSignatures: boolean;
    /** The co-signer's sticky HoldBook, or an in-memory one for the agent audit. Refreshed from Mongo here. */
    holdBook: HoldBook;
  },
): Promise<CheckContext> {
  const { client, db, policy } = deps;
  const lv = await readLedgerView(client, policy.agentAccount);
  const ledger: LedgerView = { accountSequence: lv.accountSequence, validatedLedger: lv.validatedLedger };
  const dest = typeof tx.Destination === "string" ? tx.Destination : "";
  const credential = await readCredential(client, dest, policy.credentialIssuer, { ledger_index: lv.validatedLedger, close_time: lv.closeTime });
  const history = await scanAgentHistory(client, policy.agentAccount, policy.rlusd);
  const memo = decodePaymentMemo(tx.Memos as never);
  const c = memo ? await deps.contracts(memo.ctr) : { contract: null, missing: "the tx has no valid payment memo, so there is no contract id", drift: null, note: null };
  const fresh = await readRegistrySnapshot(db);
  const registry = deps.pinned ?? fresh;
  const registryDrift =
    deps.pinned && fresh.sha256 !== deps.pinned.sha256
      ? `pinned snapshot ${deps.pinned.sha256.slice(0, 12)} (${deps.pinned.entries.length} wallets) vs database now ${fresh.sha256.slice(0, 12)} (${fresh.entries.length} wallets)`
      : null;
  // Co-signatures that can still land: LastLedgerSequence not yet passed by the scanned history and not settled in it.
  const pending = deps.signed.filter((r) => r.last_ledger_sequence > history.ledger_index_max && !(r.tx_hash && history.sent_hashes.has(r.tx_hash)));
  const nowMs = Date.now();
  await deps.holdBook.refresh(db, nowMs);
  const holds = deps.holdBook.active(nowMs, (ein) => registry.byEin.get(ein)?.address);
  return {
    ...policy,
    credential,
    holds,
    registry,
    registryDrift,
    contract: c.contract,
    contractMissing: c.missing,
    contractDrift: c.drift,
    contractNote: c.note,
    invoiceId,
    ledger,
    history,
    pending,
    signed: deps.signed,
    nowMs,
    requireSignatures: deps.requireSignatures,
  };
}

/** Policy inputs from env + registry files (AUTO_LIMIT, DAILY_CAP, PAYEE_DAILY_CAP from the root .env). */
export function policyFromEnv(p: Omit<PolicyInputs, "autoLimit" | "dailyCap" | "payeeDailyCap">): PolicyInputs {
  const num = (k: string, d: string) => {
    const v = Number(process.env[k] ?? d);
    if (!(v > 0)) throw new Error(`${k}=${process.env[k]} is not a positive number`);
    return v;
  };
  return { ...p, autoLimit: num("AUTO_LIMIT", "25"), dailyCap: num("DAILY_CAP", "300"), payeeDailyCap: num("PAYEE_DAILY_CAP", "150") };
}
