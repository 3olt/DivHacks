// Read-only verifier for a Phase 1 payment. Holds no keys (loads only the root .env).
// Looks the tx up with the `tx` RPC and checks it against the logged decision in xrpl/data/decisions.local.jsonl:
//   2 Signers = agent + cosigner (3 with the officer for an officer-approved over-limit payment, whose dh is the pending
//   decision's), SourceTag, memo {inv,ctr,ein,dh,rv} with dh == computeDecisionHash(decision),
//   memo_hash, delivered_amount to the registry wallet; plus agent_account's lsfDisableMaster + on-ledger signer list.
// Run: npm run verify -w xrpl [-- <tx hash>]   (default: the latest released decision in the log)
import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { paths } from "../src/env";
import type { Decision, Payment } from "../../shared/contracts";
import { computeDecisionHash, memoHash, MEMO_TYPE, MEMO_FORMAT, type DecisionCore } from "../../shared/hash";
import { accountState, connect, explorerTx, fromHex } from "../src/lib/xrpl";
import { decisionsLogPath, loadRegistry, nonprofitByEin } from "../src/lib/registry";

config({ path: path.join(paths.rootDir, ".env"), quiet: true });

type Line = { decision: Decision; payment: Payment | null; xrpl?: { approved_from?: string } };
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

async function main(): Promise<number> {
  const wanted = process.argv.slice(2).find((a) => /^[0-9A-Fa-f]{64}$/.test(a))?.toUpperCase();
  const lines = fs.readFileSync(decisionsLogPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Line);
  const line = [...lines].reverse().find((l) => (wanted ? l.decision.xrpl_tx_hash === wanted : l.decision.outcome === "released" && l.decision.currency === "RLUSD"));
  if (!line) throw new Error(wanted ? `no logged decision with xrpl_tx_hash ${wanted}` : "no released decision in the log");
  const d = line.decision;
  const reg = loadRegistry();
  const np = nonprofitByEin(reg, d.payee_ein);
  const client = await connect();
  try {
    const r = await client.request({ command: "tx", transaction: d.xrpl_tx_hash! });
    const tx = ((r.result as { tx_json?: Record<string, unknown> }).tx_json ?? r.result) as Record<string, unknown>;
    const meta = r.result.meta as { TransactionResult: string; delivered_amount?: { currency: string; issuer: string; value: string } };
    console.log(`tx ${d.xrpl_tx_hash}  ${explorerTx(d.xrpl_tx_hash!)}`);

    check("validated tesSUCCESS", r.result.validated === true && meta.TransactionResult === "tesSUCCESS", `validated=${r.result.validated} result=${meta.TransactionResult}`);
    check("Account is agent_account", tx.Account === reg.agent_account, String(tx.Account));
    check("SigningPubKey empty (multisig)", tx.SigningPubKey === "", JSON.stringify(tx.SigningPubKey));
    const signers = ((tx.Signers as { Signer: { Account: string } }[]) ?? []).map((s) => s.Signer.Account);
    // Phase 3: an officer-approved over-limit payment (audit.approved_from) carries 3 signatures: agent + cosigner + officer.
    const approvedFrom = line.xrpl?.approved_from;
    const want = [reg.signers.agent.address, reg.signers.cosigner.address, ...(approvedFrom ? [reg.signers.officer.address] : [])];
    const roleName = (a: string) => (a === reg.signers.agent.address ? `agent ${a}` : a === reg.signers.cosigner.address ? `cosigner ${a}` : a === reg.signers.officer.address ? `officer ${a}` : `UNKNOWN ${a}`);
    check(approvedFrom ? "3 Signers = agent + cosigner + officer" : "2 Signers = agent + cosigner", signers.length === want.length && want.every((a) => signers.includes(a)), signers.map(roleName).join(", "));
    check("SourceTag", tx.SourceTag === reg.source_tag, String(tx.SourceTag));
    check("Destination is registry wallet for EIN", !!np && tx.Destination === np.np.address, `${String(tx.Destination)} (${np?.key ?? "no registry entry"})`);

    const memo = ((tx.Memos as { Memo: { MemoType?: string; MemoFormat?: string; MemoData?: string } }[]) ?? [])[0]?.Memo;
    const memoText = memo?.MemoData ? fromHex(memo.MemoData) : "";
    const m = memoText ? (JSON.parse(memoText) as Record<string, string>) : {};
    check("MemoType / MemoFormat", !!memo && fromHex(memo.MemoType ?? "") === MEMO_TYPE && fromHex(memo.MemoFormat ?? "") === MEMO_FORMAT, `${fromHex(memo?.MemoType ?? "")} / ${fromHex(memo?.MemoFormat ?? "")}`);
    check("memo keys {inv,ctr,ein,dh,rv}", Object.keys(m).join(",") === "inv,ctr,ein,dh,rv", memoText);
    check("memo inv/ctr/ein/rv match decision", m.inv === d.invoice_id && m.ctr === d.contract_id && m.ein === d.payee_ein && m.rv === d.rule_version, `${m.inv} ${m.ctr} ${m.ein} ${m.rv}`);
    // An approved execution's memo commits to the PENDING decision the officer approved (audit.approved_from).
    const hashed = approvedFrom ? lines.find((l) => l.decision.decision_id === approvedFrom)?.decision : d;
    const recomputed = hashed ? computeDecisionHash(hashed as DecisionCore) : "(pending decision not in the log)";
    check(approvedFrom ? `dh == computeDecisionHash(pending ${approvedFrom})` : "dh == computeDecisionHash(logged decision)", m.dh === recomputed && recomputed === d.decision_hash, `dh ${m.dh} recomputed ${recomputed}`);
    check("memo_hash == sha256(on-ledger MemoData)", !!line.payment && line.payment.memo_hash === memoHash(memoText), `${line.payment?.memo_hash}`);
    check("memo under 1 KB", Buffer.byteLength(memoText) + MEMO_TYPE.length + MEMO_FORMAT.length < 1024, `${Buffer.byteLength(memoText) + MEMO_TYPE.length + MEMO_FORMAT.length} bytes`);
    const da = meta.delivered_amount;
    check(
      `delivered_amount ${d.amount} RLUSD`,
      !!da && typeof da === "object" && da.currency === reg.rlusd.currency && da.issuer === reg.rlusd.issuer && Number(da.value) === Number(d.amount),
      JSON.stringify(da),
    );

    const st = await accountState(client, reg.agent_account);
    check("agent_account lsfDisableMaster", st.masterDisabled, `Flags 0x${st.flags.toString(16)}`);
    const roles = new Map([[reg.signers.agent.address, ["agent", 1]], [reg.signers.cosigner.address, ["cosigner", 2]], [reg.signers.officer.address, ["officer", 1]]] as const);
    const slOk = !!st.signerList && st.signerList.quorum === 3 && st.signerList.entries.length === 3 && st.signerList.entries.every((e) => roles.get(e.account)?.[1] === e.weight);
    check("signer list {agent:1, cosigner:2, officer:1} quorum 3", slOk, `quorum ${st.signerList?.quorum}: ${st.signerList?.entries.map((e) => `${roles.get(e.account)?.[0] ?? "?"}:${e.weight}`).join(", ")}`);
  } finally {
    await client.disconnect();
  }
  for (const c of results) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(46)} ${c.detail}`);
  const ok = results.every((c) => c.pass);
  console.log(ok ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
  return ok ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error("verify failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
