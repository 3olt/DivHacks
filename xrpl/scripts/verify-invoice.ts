// Runs ONLY the Grok verifier + the payment builder's deterministic cross-checks on invoice files. No keys, no signing,
// no payments, nothing written. Useful to check formats and prompt-injection handling without spending Testnet RLUSD.
// Run: npm run verify-invoice -w xrpl -- <file> [<file> ...] [--contract <contract_id>]
//      (default contract: np_1's CT1-069-20261409087; JSON invoices use their own contract_id)
import path from "node:path";
import fs from "node:fs";
import { config } from "dotenv";
import { paths } from "../src/env";
import { loadRegistry } from "../src/lib/registry";
import { findContract, findNonprofit, openMongo } from "../src/lib/mongo";
import { inputFromFile, verifyInvoice, type ContractTerms } from "../src/verifier";
import { buildFromProposal } from "../src/agent/builder";

config({ path: path.join(paths.rootDir, ".env"), quiet: true });

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const ci = args.indexOf("--contract");
  const contractArg = ci >= 0 ? args[ci + 1] : undefined;
  const files = args.filter((a, i) => !a.startsWith("--") && !(ci >= 0 && i === ci + 1));
  if (!files.length) {
    console.error("usage: npm run verify-invoice -w xrpl -- <file> [...] [--contract <id>]");
    return 2;
  }
  const reg = loadRegistry();
  const m = await openMongo("divhacks-verify-invoice");
  let bad = 0;
  try {
    for (const f of files) {
      const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), f);
      const input = inputFromFile(fs.existsSync(file) ? file : path.resolve(paths.xrplDir, f));
      let contract_id = contractArg ?? reg.nonprofits.np_1.contract_id;
      if (!contractArg && input.kind === "json") {
        try {
          contract_id = String((JSON.parse(input.text) as { contract_id?: string }).contract_id ?? contract_id);
        } catch {
          /* keep default */
        }
      }
      const c = await findContract(m.db, contract_id);
      const np = c ? await findNonprofit(m.db, c.nonprofit_ein) : null;
      const terms: ContractTerms = {
        contract_id, agency_code: c?.agency_code ?? "unknown", payee_ein: c?.nonprofit_ein ?? "unknown", payee_name: np?.name ?? "unknown",
        purpose: c?.purpose ?? null, start_date: c?.start_date ?? "unknown", end_date: c?.end_date ?? "unknown",
        xrpl_budget_rlusd: c?.xrpl_budget_rlusd ?? "0", currency: "RLUSD", is_demo_data: true,
      };
      const v = await verifyInvoice(input, terms);
      console.log(`\n=== ${input.name} (${input.kind}) against ${contract_id} ===`);
      console.log(JSON.stringify({ meta: { ...v.meta, usage: undefined }, ...(v.ok ? { proposal: v.proposal } : { code: v.code, message: v.message }) }, null, 2));
      if (v.ok) {
        const b = buildFromProposal(v.proposal, { contract_id, submitted_via: "seed" }, c, reg, "unknown");
        console.log(b.ok ? `builder: OK -> ${b.np_key} ${b.destination} (${b.invoice.amount} RLUSD)` : `builder: REFUSED [${b.reasons.join(", ")}]: ${b.problems.join("; ")}`);
      } else bad++;
    }
  } finally {
    await m.close();
  }
  return bad ? 1 : 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error("verify-invoice failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
