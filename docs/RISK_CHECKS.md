# Phase 0 risk checks (2026-09-26)

Every XRPL claim below was re-checked by a second, independent agent. That agent looked up all 23 tx hashes over raw JSON-RPC, and each one was validated and matched its claim. Grok, Nessie and MongoDB were re-run with real keys. The city-data probes (Checkbook, ProPublica) were spot-checked by hand but did not get the full independent pass (see "Data" below).

Scripts: [`xrpl/scripts/risk/`](../xrpl/scripts/risk/README.md) (Node) and [`data/risk_checks/`](../data/risk_checks/README.md) (Python, with full findings).

## Summary

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | XRPL Testnet faucet wallet + XRP payment | ✅ PASS | [1 XRP payment with SourceTag + Memo](https://testnet.xrpl.org/transactions/FCF8978B3F82AD44F6DBA73A555D80D7902804A7E2D50E70F60C1CB39EEB7741) (`tesSUCCESS`). Faucet gives 100 XRP per call; 10 calls, no rate limit hit |
| 2a | RLUSD Testnet issuer from docs.ripple.com | ✅ PASS | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`, currency hex `524C555344000000000000000000000000000000` ([source](https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl)). On-ledger: RequireAuth off, TransferRate 0%, clawback on |
| 2b | Get RLUSD from tryrlusd.com | ⚠️ PARTIAL | Needs GitHub sign-in + a browser wallet (Connect Wallet), and gives **10 RLUSD / 24h**. Treasury `rLfrnvDZ4WsFybU8yCbA16jEvsMCQc6mkJ` has its [RLUSD trustline](https://testnet.xrpl.org/transactions/EFF39A0C9AA516F2FD3C57A80E63CD49349B756BEE3ED2DE7F0A8DE363C776C6) and 0 RLUSD |
| 2c | RLUSD via the Testnet AMM instead | ✅ PASS | Pool 757k XRP / 227k RLUSD, ≈0.30 RLUSD per XRP, 0.5% fee. [Proof swap](https://testnet.xrpl.org/transactions/B7FD0F021D47A8AFBD82A0748DAC955DE1A4E3398C22539C60BB7E60C33B0729): 5 XRP → 1.49 RLUSD. ≈26.8 RLUSD per faucet call |
| 3 | RLUSD escrow (TokenEscrow) | ❌ FAIL | Amendment is **enabled**, but the RLUSD issuer lacks `lsfAllowTrustLineLocking`, so every RLUSD `EscrowCreate` → `tecNO_PERMISSION` ([tx](https://testnet.xrpl.org/transactions/93268D1472B2E84E9536EA46926EC8C4BD0584216F80A806E6FB1A8033C798B5), even from a funded holder). Only Ripple can change this |
| 3b | Escrow of a self-issued token (fallback) | ✅ PASS | [EscrowCreate](https://testnet.xrpl.org/transactions/3868D27ECD819A55D0F8657ABC6C52DE70CF159CAA6EC953F88969A9CD892F15) with PREIMAGE-SHA-256 + CancelAfter → [EscrowFinish](https://testnet.xrpl.org/transactions/67E76D72B40DD2F8DD710A4109A94F9F4409B7CC5429ECA406149C0AFCC26AF5) |
| 4 | Credentials (XLS-70) | ✅ PASS | [CredentialCreate](https://testnet.xrpl.org/transactions/48B1DC96D078E0E8372DBE1B98273CEA6C8B02CECF7E64DB000F511DCEE92DA3) `NYC_VERIFIED_NONPROFIT` → [CredentialAccept](https://testnet.xrpl.org/transactions/C1ADEB8DAFDE67C58D075255D6DAF4703BAD56EFC87B82F6FCDF4604C120CA48) → `ledger_entry` shows `lsfAccepted`. Past Expiration → `tecEXPIRED` |
| 4b | *Bonus:* multisig quorum enforced by the ledger | ✅ PASS | SignerList {1,2,1}, quorum 3, master disabled. 2 signers (weights 1+2) → [`tesSUCCESS`](https://testnet.xrpl.org/transactions/BE510AC56DAE283688553FE264494E63AAC9885483C63C37E5AABDC1E9BA68F6). 1 signer → **`tefBAD_QUORUM`**. Master key → **`tefMASTER_DISABLED`** |
| 5 | Checkbook NYC XML API | ⚠️ PARTIAL | **Spending: PASS**, 19 real HRA payments to Food Bank For NYC (FY2026, $1.75M, 3 contracts). **Contracts: not finished**; each request takes ~23 min. Contract-level fallback works (Comptroller appendix). No EIN in Checkbook |
| 6 | ProPublica 990 API | ✅ PASS | `organizations/133179546.json` → Food Bank For New York City, FY2023 revenue $164.3M. No cash field, so cash comes from the IRS 990 XML: FY2025 = **0.35 months** of cash |
| 7 | Grok API | ✅ PASS | Base URL `https://api.x.ai/v1`, model `grok-4.3`. Key works: json_schema structured output (~2.2 s) + image input. PDFs: extract text or rasterize locally |
| 8 | Nessie | ✅ PASS | **HTTPS only**: `http://` times out. Key proven with a POST (`201 Customer created`; a bad key gets `401`). GETs return 200 `[]` even for invalid keys |
| – | MongoDB Atlas | ✅ PASS | Ping + write/read/delete in db `divhacks`, server 8.0, ~350 ms |

## What this means for later phases

1. **Ripple core design is proven.** A payment signed by the agent key alone is rejected by the ledger (`tefBAD_QUORUM`). `tef` results never reach the ledger, so the demo evidence is the `engine_result` stored in `Decision.ledger_result`, not an explorer link.
2. **RLUSD escrow is out.** Per the spec, Phase 3 step 5 is skipped. Optional: escrow a city-issued token, clearly labeled.
3. **RLUSD supply limits amounts.** AUTO_LIMIT=2500 would need about 94 faucet calls and DAILY_CAP=10000 about 390. Proposal: testnet-scale limits (e.g. AUTO_LIMIT=25, DAILY_CAP=100 RLUSD), invoices of 5–40 RLUSD, and the UI labels them as scaled testnet amounts. About 4 faucet wallets swapped via the AMM give about 100 RLUSD in minutes (`xrpl/scripts/risk/dex-rlusd.ts`).
4. **Never send anything to the RLUSD issuer.** It has DepositAuth, RequireDestTag and DisallowXRP set.
5. **Checkbook is slow and single-threaded.** Ingestion must be sequential, cached, and never run on page load. Vendors are linked to EINs through a reviewed crosswalk (`ein ↔ vendor_code`), never by name.
6. **Agency lateness is registration lateness.** FY2024 human services, computed from the Comptroller appendix: HRA 87.4% late, DHS 85.0%, DYCD 98.6%. The citywide 90.7% matches the published figure.
7. **Golden site candidate: Food Bank For New York City** (EIN 13-3179546, vendor 0000822784). It has real HRA contracts and payments, a 990, and 0.35 months of cash.
8. **Nessie POST returns the created object with `_id`**, contrary to its OpenAPI spec. Customers cannot be deleted. Nessie's enterprise endpoint exposes every user's customers, so only public org data goes into Nessie.

## Data (partially verified)

The data agent was stopped before its independent verifier ran, to save time. Hand-checked afterwards: the Checkbook spending sample holds real rows for `FOOD BANK FOR NEW YORK CITY` (`record_count` 19), and ProPublica returns the same org, EIN and FY2023 numbers live. Still unverified: the IRS 990 XML cash figures, the Comptroller per-agency percentages, and the NYC Open Data dataset list. They will be re-checked in Phase 4 before any of them reach the map.
