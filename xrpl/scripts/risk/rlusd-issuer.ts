// X2: RLUSD Testnet issuer on-ledger sanity (read-only): account flags, TransferRate, obligations,
// and whether city_treasury's RLUSD trust line exists / needed issuer authorization.
// Run: cd xrpl && npx tsx scripts/risk/rlusd-issuer.ts
import { connect, header, RLUSD_ISSUER, RLUSD_CUR } from "./_lib";

// AccountRoot flags (values from xrpl.js 5.3 models/ledger/AccountRoot.d.ts)
const ACCOUNT_FLAGS: Record<string, number> = {
  lsfPasswordSpent: 0x00010000, lsfRequireDestTag: 0x00020000, lsfRequireAuth: 0x00040000, lsfDisallowXRP: 0x00080000,
  lsfDisableMaster: 0x00100000, lsfNoFreeze: 0x00200000, lsfGlobalFreeze: 0x00400000, lsfDefaultRipple: 0x00800000,
  lsfDepositAuth: 0x01000000, lsfAMM: 0x02000000, lsfDisallowIncomingNFTokenOffer: 0x04000000,
  lsfDisallowIncomingCheck: 0x08000000, lsfDisallowIncomingPayChan: 0x10000000, lsfDisallowIncomingTrustline: 0x20000000,
  lsfAllowTrustLineLocking: 0x40000000, lsfAllowTrustLineClawback: 0x80000000,
};

// RippleState flags (for the trust line object itself)
const RS_FLAGS: Record<string, number> = {
  lsfLowReserve: 0x00010000, lsfHighReserve: 0x00020000, lsfLowAuth: 0x00040000, lsfHighAuth: 0x00080000,
  lsfLowNoRipple: 0x00100000, lsfHighNoRipple: 0x00200000, lsfLowFreeze: 0x00400000, lsfHighFreeze: 0x00800000,
  lsfAMMNode: 0x01000000, lsfLowDeepFreeze: 0x02000000, lsfHighDeepFreeze: 0x04000000,
};

function decode(flags: number, table: Record<string, number>) {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(table)) out[k] = (flags & v) !== 0;
  return out;
}

async function main() {
  header("X2 RLUSD issuer sanity");
  const treasury = process.env.TREASURY_ADDRESS;
  const client = await connect();
  try {
    const ai = await client.request({ command: "account_info", account: RLUSD_ISSUER, ledger_index: "validated" });
    const ad = ai.result.account_data as unknown as Record<string, unknown>;
    const flags = Number(ad.Flags);
    const decoded = decode(flags, ACCOUNT_FLAGS);
    const transferRate = ad.TransferRate as number | undefined;
    console.log(JSON.stringify({
      issuer: RLUSD_ISSUER,
      ledger_index: ai.result.ledger_index,
      Flags: flags,
      Flags_hex: "0x" + flags.toString(16).toUpperCase(),
      decoded_account_flags: decoded,
      server_account_flags: (ai.result as unknown as { account_flags?: unknown }).account_flags,
      TransferRate: transferRate ?? "(unset = 1.0, no transfer fee)",
      transfer_fee_pct: transferRate ? ((transferRate - 1e9) / 1e7).toFixed(4) + "%" : "0%",
      TickSize: ad.TickSize, Domain: ad.Domain ? Buffer.from(String(ad.Domain), "hex").toString() : undefined,
      Balance_XRP: Number(ad.Balance) / 1e6, OwnerCount: ad.OwnerCount, Sequence: ad.Sequence,
    }, null, 2));

    const gb = await client.request({ command: "gateway_balances", account: RLUSD_ISSUER, ledger_index: "validated" } as never);
    const gbr = (gb as { result: Record<string, unknown> }).result;
    console.log("gateway_balances.obligations:", JSON.stringify(gbr.obligations));
    if (gbr.frozen_balances) console.log("gateway_balances.frozen_balances:", JSON.stringify(gbr.frozen_balances));
    if (gbr.locked) console.log("gateway_balances.locked:", JSON.stringify(gbr.locked));

    if (!treasury) {
      console.log("TREASURY_ADDRESS not set; skipping trust line check");
      return;
    }
    const lines = await client.request({ command: "account_lines", account: treasury, peer: RLUSD_ISSUER, ledger_index: "validated" });
    const line = lines.result.lines.find((l) => l.currency === RLUSD_CUR);
    console.log("treasury account_lines entry:", JSON.stringify(line ?? null));
    if (line) {
      const rs = await client.request({
        command: "ledger_entry",
        ripple_state: { accounts: [treasury, RLUSD_ISSUER], currency: RLUSD_CUR },
        ledger_index: "validated",
      });
      const node = rs.result.node as unknown as { Flags: number; LowLimit: { issuer: string }; HighLimit: { issuer: string }; Balance: unknown };
      const rsFlags = decode(node.Flags, RS_FLAGS);
      const issuerIsLow = node.LowLimit.issuer === RLUSD_ISSUER;
      const issuerAuthorized = issuerIsLow ? rsFlags.lsfLowAuth : rsFlags.lsfHighAuth;
      console.log(JSON.stringify({
        ripple_state_index: rs.result.index,
        Flags: node.Flags,
        decoded: rsFlags,
        issuer_side: issuerIsLow ? "low" : "high",
        issuer_authorized_line: issuerAuthorized,
        needs_issuer_authorization: decoded.lsfRequireAuth ?? false,
        treasury_RLUSD_balance: line.balance,
      }, null, 2));
    }
  } finally {
    await client.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
