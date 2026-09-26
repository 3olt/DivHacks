# DivHacks 2026

A live NYC map of community services (food pantries, shelters, youth programs). Each pin is colored by how stuck the **city money** behind it is, based on public spending records. Click a pin to see the money trail: agency → contract → payments → nonprofit.

The fix layer is an AI payment agent. It pays nonprofits' verified invoices in **RLUSD on the XRP Ledger (Testnet)**, and the ledger itself enforces the guardrails: the agent's key carries only 1 of the 3 signature weights a payment needs.

Project context and pitch: [`context.md`](context.md). API contract for the frontend: [`docs/API.md`](docs/API.md).

**Where things stand:** [`docs/STATUS.md`](docs/STATUS.md): what's built, the guardrails with real Testnet evidence, what's real vs demo, and what's next. Raw public data: [`data/raw/public/`](data/raw/public/README.md).

## Layout

| Path | What | Owner |
|---|---|---|
| `web/` | Next.js map frontend | frontend |
| `api/` | Fastify + TypeScript REST API and WebSocket `/live` (:4000) | backend |
| `xrpl/` | XRPL agent, payment builder, compliance co-signer, demo scripts (Node + xrpl.js) | backend |
| `data/` | Python ingestion: Checkbook NYC, Comptroller, ProPublica 990, NYC Open Data, risk score | backend |
| `shared/contracts.ts` | Shared data types (source of truth for `docs/API.md`) | backend |
| `docs/` | `API.md` (frontend contract), risk-check results | backend |

## Run it

Requires Node 20+ (22 tested) and Python 3.12.

```bash
npm install            # installs api/ and xrpl/ (npm workspaces). web/ has its own install.
cp .env.example .env   # then fill in keys (never commit .env)
```

**API (fixture mode, no keys needed):**

```bash
npm run dev:api        # http://localhost:4000  ·  ws://localhost:4000/live
npm run smoke:api      # in a second terminal: checks every endpoint + the WebSocket
```

**Frontend:**

```bash
cd web && npm install && npm run dev   # http://localhost:3000
```

**Phase 0 risk checks** (XRPL Testnet, city data, Grok, Nessie): see [`docs/RISK_CHECKS.md`](docs/RISK_CHECKS.md).

**Phase 1: autonomous RLUSD payment on XRPL Testnet** (details: [`xrpl/README.md`](xrpl/README.md)):

```bash
npm run setup:xrpl          # idempotent: accounts, RLUSD trust lines, treasury RLUSD via the Testnet AMM, agent top-up,
                            # multisig {agent:1, cosigner:2, officer:1} quorum 3, master key disabled. A re-run submits 0 txs.
npm run demo happy          # the agent pays a seeded 12.50 RLUSD invoice with the co-signer (no human); prints EXPLORER: <link>
npm run verify -w xrpl      # read-only on-ledger check of the latest released payment
```

For the judged demo, run the compliance co-signer as its own process in a separate terminal, so the agent never starts it:

```bash
npm run cosigner            # terminal 1: co-signer on :4002 (COSIGNER_URL), holds only its own key
npm run demo happy no-spawn # terminal 2: the agent
```

Without a running co-signer, `npm run demo happy` starts one as a child process and stops it afterwards (dev convenience).

## Secrets

- Shared config and API keys: repo-root `.env` (gitignored). Template: `.env.example`.
- XRPL seeds: `xrpl/.env.local` (setup accounts) and `xrpl/.env.agent`, `xrpl/.env.cosigner`, `xrpl/.env.officer` (one signer per process). All gitignored.
- XRPL is **Testnet only**. Testnet tokens have no value.

## Honesty

- Spending, contract and 990 data are real public records and carry `source` + `source_url`.
- Events, invoices and XRPL payments are seeded or Testnet, and flagged `is_demo_data: true`.
- The API currently serves **fixture data** (all `is_demo_data: true`) so the frontend can build against the final shapes.
