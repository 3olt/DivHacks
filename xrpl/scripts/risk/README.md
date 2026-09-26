# Phase 0 XRPL risk checks (Testnet only)

Run everything from `xrpl/`. Throwaway wallets are created once and their seeds appended to the gitignored
`xrpl/.env.local` as `RISK_<NAME>_SEED`, so re-runs reuse them (no extra faucet calls). `_lib.ts` holds the shared helpers.

| Script | What it proves | Run |
|---|---|---|
| `treasury.ts` | Creates/reuses `city_treasury` and its RLUSD trust line (target for tryrlusd.com). | `npx tsx scripts/risk/treasury.ts` |
| `xrp-payment.ts` | X1: faucet works (100 XRP per call) and a 1 XRP Payment with SourceTag 26092026 + `divhacks/risk/v1` Memo validates `tesSUCCESS`. | `npx tsx scripts/risk/xrp-payment.ts` |
| `rlusd-issuer.ts` | X2 (read-only): decodes the RLUSD issuer's account flags, TransferRate, `gateway_balances` obligations, and whether treasury's trust line exists / needed issuer auth. | `npx tsx scripts/risk/rlusd-issuer.ts` |
| `dex-rlusd.ts` | X3: reads the XRP/RLUSD AMM + both order books, quotes what 90 XRP buys (`ripple_path_find`), and proves it with one small XRP→RLUSD swap (Payment-to-self, SendMax XRP) into a throwaway wallet. Swaps only if that wallet holds 0 RLUSD. | `npx tsx scripts/risk/dex-rlusd.ts [--quote-only] [--swap] [--xrp=5]` |
| `token-escrow.ts` | X4: TokenEscrow amendment status; RLUSD `EscrowCreate` from `city_treasury` (full create+finish if it holds ≥1 RLUSD) and from a DEX-funded holder; self-issued-token escrow create+finish with a PREIMAGE-SHA-256 condition. Prints a one-line verdict. Re-run after RLUSD arrives. | `npx tsx scripts/risk/token-escrow.ts [--skip-treasury] [--skip-tst]` |
| `credentials.ts` | X5: XLS-70 `CredentialCreate` → `CredentialAccept` → `ledger_entry` read-back (lsfAccepted, Expiration, URI), plus a past-Expiration create (`tecEXPIRED`). | `npx tsx scripts/risk/credentials.ts` |
| `multisig.ts` | X6: the ledger enforces quorum. M = SignerList {S1:1,S2:2,S3:1} quorum 3 + master disabled; S1+S2 → `tesSUCCESS`, S1 alone → `tefBAD_QUORUM`, master key → `tefMASTER_DISABLED`. | `npx tsx scripts/risk/multisig.ts` |
| `grok.ts`, `nessie.ts` | Service checks written by another agent (Grok/xAI, Nessie); see `README-services.md`. | `npx tsx scripts/risk/grok.ts`, `npx tsx scripts/risk/nessie.ts` |

Results from 2026-09-26: TokenEscrow is **enabled** on Testnet, but the RLUSD Testnet issuer does **not** have
`lsfAllowTrustLineLocking`, so **RLUSD escrow fails with `tecNO_PERMISSION`**, even from a funded holder. Self-issued-token escrow works.
The XRP/RLUSD AMM pays about 0.30 RLUSD per XRP (90 XRP ≈ 26.8 RLUSD).
