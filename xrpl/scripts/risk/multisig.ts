// X6: the ledger (not our code) enforces the agent's quorum. Throwaway account M gets
// SignerListSet {S1:1, S2:2, S3:1} quorum 3 + asfDisableMaster, then:
//   (a) S1+S2 multisigned 1 XRP payment -> expect tesSUCCESS
//   (b) S1-only multisigned payment      -> expect tefBAD_QUORUM
//   (c) M master-key single-signed       -> expect tefMASTER_DISABLED
// Idempotent: skips setup if M already has the signer list and master disabled. Never touches city_treasury.
// Run: cd xrpl && npx tsx scripts/risk/multisig.ts
import { multisign, hashes, xrpToDrops, AccountSetAsfFlags, type Client, type Payment, type Wallet } from "xrpl";
import { connect, fundedWallet, keypair, submitWait, submitBlob, header, toHex, SOURCE_TAG } from "./_lib";

const LSF_DISABLE_MASTER = 0x00100000;

function payment(m: string, dest: string, label: string): Payment {
  return {
    TransactionType: "Payment", Account: m, Destination: dest, Amount: xrpToDrops(1), SourceTag: SOURCE_TAG,
    Memos: [{ Memo: { MemoType: toHex("divhacks/risk/v1"), MemoData: toHex(`X6 ${label}`) } }],
  };
}

async function multisigned(client: Client, tx: Payment, signers: Wallet[], label: string) {
  const prepared = await client.autofill(tx, signers.length);
  const blobs = signers.map((s) => s.sign(prepared, true).tx_blob);
  const combined = multisign(blobs);
  const hash = hashes.hashSignedTx(combined);
  return submitBlob(client, combined, hash, label);
}

async function main() {
  header("X6 multisig quorum enforced by the ledger");
  const client = await connect();
  try {
    const m = await fundedWallet(client, "MS_M", 10);
    const s1 = keypair("MS_S1"), s2 = keypair("MS_S2"), s3 = keypair("MS_S3");
    const dest = process.env.RISK_X1_B_ADDRESS ?? (await fundedWallet(client, "X1_B")).address;
    const want = new Map([[s1.address, 1], [s2.address, 2], [s3.address, 1]]);

    const info = await client.request({ command: "account_info", account: m.address, ledger_index: "validated", signer_lists: true } as never);
    const ir = (info as { result: { account_data: { Flags: number; signer_lists?: unknown[] }; signer_lists?: { SignerQuorum: number; SignerEntries: { SignerEntry: { Account: string; SignerWeight: number } }[] }[] } }).result;
    const lists = ir.signer_lists ?? ir.account_data.signer_lists ?? [];
    const sl = lists[0] as { SignerQuorum: number; SignerEntries: { SignerEntry: { Account: string; SignerWeight: number } }[] } | undefined;
    const listOk = !!sl && sl.SignerQuorum === 3 && sl.SignerEntries.length === 3 && sl.SignerEntries.every((e) => want.get(e.SignerEntry.Account) === e.SignerEntry.SignerWeight);
    const masterDisabled = (Number(ir.account_data.Flags) & LSF_DISABLE_MASTER) !== 0;
    const setup: Record<string, unknown> = {};

    if (!listOk) {
      if (masterDisabled) throw new Error("M has master disabled but an unexpected signer list; delete RISK_MS_* from .env.local to start over");
      const r = await submitWait(client, {
        TransactionType: "SignerListSet", Account: m.address, SignerQuorum: 3,
        SignerEntries: [...want].map(([Account, SignerWeight]) => ({ SignerEntry: { Account, SignerWeight } })),
      }, m, "SignerListSet {S1:1,S2:2,S3:1} quorum 3");
      setup.SignerListSet = { hash: r.hash, result: r.result, link: r.link };
    } else setup.SignerListSet = "already in place";
    if (!masterDisabled) {
      const r = await submitWait(client, { TransactionType: "AccountSet", Account: m.address, SetFlag: AccountSetAsfFlags.asfDisableMaster }, m, "AccountSet SetFlag 4 (asfDisableMaster)");
      setup.DisableMaster = { hash: r.hash, result: r.result, link: r.link };
    } else setup.DisableMaster = "already disabled";

    const a = await multisigned(client, payment(m.address, dest, "S1+S2"), [s1, s2], "(a) S1+S2 multisigned 1 XRP");
    const b = await multisigned(client, payment(m.address, dest, "S1 only"), [s1], "(b) S1-only multisigned 1 XRP");
    const cPrepared = await client.autofill(payment(m.address, dest, "master key"));
    const cSigned = m.sign(cPrepared);
    const c = await submitBlob(client, cSigned.tx_blob, cSigned.hash, "(c) master-key single-signed 1 XRP");

    console.log(JSON.stringify({
      check: "X6", account_M: m.address, signers: { S1: s1.address, S2: s2.address, S3: s3.address }, destination: dest, setup,
      a_S1_S2: a, b_S1_only: b, c_master_key: c,
      pass: (a.final ?? a.engine_result) === "tesSUCCESS" && b.engine_result === "tefBAD_QUORUM" && c.engine_result === "tefMASTER_DISABLED",
    }, null, 2));
  } finally {
    await client.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
