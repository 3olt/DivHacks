// Kill switch, OFFICER side (Phase 3, builder B). Holds only the officer signer key (weight 1).
//   REVOKED   = SignerListSet {cosigner:2, officer:1} quorum 3 on agent_account: the agent key no longer counts, so any
//               payment the agent signs fails ON-LEDGER (tefBAD_SIGNATURE: a signer is not in the signer list).
//   CANONICAL = SignerListSet {agent:1, cosigner:2, officer:1} quorum 3 (restore).
// Both are signed by the officer (1) and co-signed by the co-signer (2) through POST /governance/cosign, which accepts
// ONLY these two configurations. The agent is never needed and can do neither. Idempotent: if agent_account is already
// in the target configuration nothing is submitted. The account is never left without a signer list (the master key is
// disabled, so the ledger itself refuses to delete the list), and restore works from REVOKED at any time.
import { decode, hashes, multisign, type Client, type SignerListSet, type Wallet } from "xrpl";
import type { Registry } from "../lib/registry";
import { accountState, explorerTx, submitBlobAndWait } from "../lib/xrpl";
import { classifySignerList, signerEntriesFor, GOV_QUORUM, type GovPurpose, type SignerListName } from "../lib/governance";

export interface GovOutcome {
  ok: boolean;
  target: SignerListName;
  changed: boolean;
  before: string;
  after: string;
  master_disabled: boolean;
  engine_result: string | null;
  final: string | null;
  tx_hash: string | null;
  explorer_url: string | null;
  message: string;
}

export const govSigners = (reg: Registry) => ({ agent: reg.signers.agent.address, cosigner: reg.signers.cosigner.address, officer: reg.signers.officer.address });

export async function signerListStatus(client: Client, reg: Registry): Promise<{ config: string; master_disabled: boolean; entries: { role: string; account: string; weight: number }[]; quorum: number | null }> {
  const st = await accountState(client, reg.agent_account);
  const s = govSigners(reg);
  const role = (a: string) => (a === s.agent ? "agent" : a === s.cosigner ? "cosigner" : a === s.officer ? "officer" : "unknown");
  return {
    config: classifySignerList(st.signerList, s),
    master_disabled: st.masterDisabled,
    quorum: st.signerList?.quorum ?? null,
    entries: (st.signerList?.entries ?? []).map((e) => ({ role: role(e.account), account: e.account, weight: e.weight })),
  };
}

export async function setAgentSignerList(
  target: SignerListName,
  deps: { client: Client; officer: Wallet; reg: Registry; cosignerUrl: string; log: (m: string) => void },
): Promise<GovOutcome> {
  const { client, officer, reg, log } = deps;
  const s = govSigners(reg);
  const purpose: GovPurpose = target === "REVOKED" ? "revoke_agent" : "restore_agent";
  const out = (o: Partial<GovOutcome> & { message: string; ok: boolean; before: string; after: string; master_disabled: boolean }): GovOutcome => ({
    target, changed: false, engine_result: null, final: null, tx_hash: null, explorer_url: null, ...o,
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    const st = await accountState(client, reg.agent_account);
    const before = classifySignerList(st.signerList, s);
    if (before === target) return out({ ok: true, before, after: before, master_disabled: st.masterDisabled, message: `agent_account is already ${target}; nothing submitted` });
    if (before !== "CANONICAL" && before !== "REVOKED") {
      return out({ ok: false, before, after: before, master_disabled: st.masterDisabled, message: `agent_account's signer list is ${before}, neither CANONICAL nor REVOKED; refusing to touch it (fix by hand)` });
    }
    const tx: SignerListSet = { TransactionType: "SignerListSet", Account: reg.agent_account, SignerQuorum: GOV_QUORUM, SignerEntries: signerEntriesFor(target, s) };
    const prepared = await client.autofill(tx, 2);
    const officerBlob = officer.sign(prepared, true).tx_blob;
    log(`officer: signed SignerListSet -> ${target} (Sequence ${prepared.Sequence}, LastLedgerSequence ${prepared.LastLedgerSequence}); asking the co-signer (POST /governance/cosign ${purpose})`);
    let cos: { ok?: boolean; signed_blob?: string; problems?: string[]; message?: string; detail?: string };
    try {
      const r = await fetch(`${deps.cosignerUrl}/governance/cosign`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_blob: officerBlob, purpose }), signal: AbortSignal.timeout(30000),
      });
      cos = (await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status} with a non-JSON body` }))) as typeof cos;
    } catch (e) {
      return out({ ok: false, before, after: before, master_disabled: st.masterDisabled, message: `co-signer unreachable at ${deps.cosignerUrl} (${(e as Error).message}); nothing submitted` });
    }
    if (!cos.ok || !cos.signed_blob) return out({ ok: false, before, after: before, master_disabled: st.masterDisabled, message: `co-signer refused: ${(cos.problems ?? [cos.message ?? "unknown"]).join("; ")}` });
    const cosSigner = (decode(cos.signed_blob) as { Signers?: { Signer: { Account: string } }[] }).Signers?.[0]?.Signer.Account;
    if (cosSigner !== s.cosigner) return out({ ok: false, before, after: before, master_disabled: st.masterDisabled, message: `the co-signer returned a signature from ${cosSigner}` });
    const blob = multisign([officerBlob, cos.signed_blob]);
    const hash = hashes.hashSignedTx(blob);
    log(`officer: co-signer signed (${cos.detail ?? purpose}); submitting ${hash} (officer 1 + co-signer 2 = quorum 3)`);
    const sub = await submitBlobAndWait(client, blob, hash, prepared.LastLedgerSequence!);
    const st2 = await accountState(client, reg.agent_account);
    const after = classifySignerList(st2.signerList, s);
    log(`ledger: ${sub.engine_result} -> ${sub.status}: ${sub.final}; agent_account signer list now ${after}, master key disabled ${st2.masterDisabled}`);
    const retryable = /^(tefPAST_SEQ|tefMAX_LEDGER|terPRE_SEQ)$/.test(sub.engine_result) || sub.status === "expired";
    if (after !== target && retryable && attempt < 2) {
      log(`officer: ${sub.final}; rebuilding once with a fresh Sequence`);
      continue;
    }
    return out({
      ok: after === target && sub.final === "tesSUCCESS", changed: after !== before, before, after, master_disabled: st2.masterDisabled,
      engine_result: sub.engine_result, final: sub.final, tx_hash: sub.validated ? hash : null, explorer_url: sub.validated ? explorerTx(hash) : null,
      message: after === target ? `agent_account is now ${target}` : `agent_account is still ${after} (${sub.final})`,
    });
  }
  throw new Error("unreachable");
}
