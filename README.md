# GlassLedger

**Follow NYC's money in the open: see how city dollars move from agencies to food pantries, shelters and youth programs, where they get stuck, and every payment on a public ledger.**

A live map of NYC's food pantries, shelters and youth programs, each colored by how stuck the city money behind it is, built from public spending records. Click a pin to see the money trail: agency → contract → payments → nonprofit, with a source link for every number.

To fix the last step, an AI agent pays nonprofits' verified invoices in **RLUSD on the XRP Ledger (Testnet)**. It pays on its own, but it can't pay alone: its key holds only 1 of the 3 signature weights a payment needs, so the ledger itself rejects the agent acting alone.

DivHacks 2026 · Hack the City. Devpost write-up: [`docs/DEVPOST.md`](docs/DEVPOST.md).

## The problem

- NYC owed nonprofits **$861M across ~4,000 unpaid invoices** (NYC Comptroller, *Nonprofit, Nonpayment*, Apr 2025). A follow-up found **7,000+ invoices and over $1B**.
- **90.7%** of human-service contracts were registered late in FY2024, and nobody gets paid before registration.
- Residents find out a program is gone when the doors are locked. The data that shows it coming is public but split across Checkbook NYC, Comptroller filings and IRS 990s.

We don't fix the paperwork. We make the delays visible, and once the work is verified, we move the money in seconds to a verified recipient, with a record anyone can check.

## What it does

| Part | Where | What |
|---|---|---|
| **Money map** | `/map`, `/sites/<id>` | 15 real nonprofits from public records, colored 🟢 stable / 🟡 strained / 🔴 critical by an explainable 0–100 **financial status rating** (payment pace 40, contract registration lateness 20, agency lateness 20, months of cash 20). Money trail with sources, and a full report per site. |
| **Text line** | iMessage via Photon | Text a NYC ZIP for nearby places and their funding status. `FOLLOW <place>` for alerts, ask "why?" (Grok answers from our data only), `STOP` to delete. No app, no sign-up. |
| **Payment agent** | `xrpl/`, `/demo` | Pays verified RLUSD invoices autonomously. Grok reads the invoice but never outputs an address; an independent co-signer re-checks 8 rules against the ledger; the ledger's multisig quorum enforces it. |
| **Open data** | `/data` | Every record behind the map (search, sort, JSON/CSV), plus the agent's transactions read straight from the XRPL Testnet in the browser. |

## How the agent is guarded

- **Multisig:** agent weight 1, compliance co-signer weight 2, human officer weight 1, quorum 3, master key disabled.
- **Co-signer:** a separate process with its own key; it never sees the AI's text. It runs 8 checks before signing: valid on-ledger credential, the registered wallet, not already paid, within the contract amount, under the auto-limit or officer-signed, daily caps, payee not excluded, transaction well-formed.
- **Over 25 RLUSD** the human officer adds the third signature. The officer and co-signer can revoke the agent's key (kill switch).
- **Verified payees only:** public record (IRS/ProPublica + Checkbook NYC) → bank check (Capital One Nessie, micro-deposits) → signed wallet challenge → on-ledger `NYC_VERIFIED_NONPROFIT` credential (XLS-70).
- **Audit trail:** every decision is stored in MongoDB Atlas, and its SHA-256 hash goes in the payment's on-chain memo with the invoice id, contract and EIN.

| Attack | Stopped by | Result on Testnet |
|---|---|---|
| Prompt injection in the invoice | Grok flag + agent policy, then co-signer, then ledger | refused, nothing signed; hacked agent alone: `tefBAD_QUORUM` |
| Leaked agent key, pays alone | the ledger | `tefBAD_QUORUM` |
| "We changed our bank details" | 72-hour hold (the agent can't lift it) | refused, original wallet paid |
| Same invoice twice | co-signer, on-ledger memos | refused `invoice_already_paid` |
| Over the contract budget | co-signer, on-ledger sum | refused `contract_amount_exceeded` |
| Payee without a credential | co-signer, on-ledger credential | refused `credential_invalid` |
| Over the auto-limit | co-signer + officer | waits for the officer; paid with 3 signatures |
| Rogue agent | officer + co-signer revoke its key | `tefBAD_SIGNATURE` |

Evidence with explorer links, and what's real vs demo: [`docs/STATUS.md`](docs/STATUS.md).

## Layout

| Path | What | Owner |
|---|---|---|
| `web/` | Next.js frontend: landing page, `/map`, `/sites/<id>`, `/demo`, `/data` (:3000) | Noel (`/data`: Gagan) |
| `imessage/` | iMessage line via Photon Spectrum: ZIP, FOLLOW, HELP, STOP, Grok answers, funded alerts (:4003) | Noel |
| `api/` | Fastify + TypeScript REST API and WebSocket `/live`, reads MongoDB (:4000) | Gagan |
| `xrpl/` | XRPL agent service (:4001), Grok verifier, compliance co-signer (:4002), officer (:4004), onboarding, kill switch, escrow, demo scripts | Gagan |
| `data/` | Python pipeline: public records → MongoDB, `risk.py` (the rating), Grok summaries. Raw public data in [`data/raw/public/`](data/raw/public/README.md) | Gagan |
| `shared/contracts.ts` | Shared data types (source of truth for `docs/API.md`) | Gagan |
| `docs/` | [`API.md`](docs/API.md) (API contract), [`DEMO.md`](docs/DEMO.md) (demo runbook), [`STATUS.md`](docs/STATUS.md) (evidence), [`DEVPOST.md`](docs/DEVPOST.md) | both |

Project context and pitch: [`context.md`](context.md).

## Run it

Requires Node 20+ (22 tested) and Python 3.12.

```bash
npm install            # installs api/ and xrpl/ (npm workspaces). web/ and imessage/ have their own installs.
cp .env.example .env   # then fill in keys (never commit .env)
```

**Quick look (no keys):** the API falls back to fixture data when MongoDB isn't reachable.

```bash
API_MODE=fixtures npm run dev:api        # http://localhost:4000  ·  ws://localhost:4000/live
cd web && npm install && npm run dev     # http://localhost:3000 (landing), /map, /demo, /data
npm run smoke:api                        # checks every endpoint + the WebSocket
```

**Real data:** with `MONGODB_URI` set, `npm run start:api` serves the 15 real nonprofits and 4 labeled demo sites from MongoDB Atlas. Loading the data: [`data/README.md`](data/README.md).

**Full demo with real Testnet payments:** needs the XRPL signer keys, which live only on the demo laptop. Pre-flight, the 3-minute script and fallbacks: [`docs/DEMO.md`](docs/DEMO.md).

```bash
npm run cosigner                                   # :4002 compliance co-signer (its own key)
npm run xrpl:service                               # :4001 the agent
npm run officer                                    # :4004 the human officer (its own key)
API_MODE=mongo DEMO_NO_SPAWN=1 npm run start:api   # :4000; the /demo buttons run real Testnet scenarios
npm run demo:reset                                 # signer list, holds, demo scores, agent balance
```

> ⚠️ `npm run setup:xrpl` creates the Testnet accounts, trust lines and signer list. Run it only on the laptop that already holds the keys: anywhere else it creates brand-new accounts and breaks the shared setup.

**From the command line:**

```bash
npm run demo all            # every scenario on Testnet (26 steps): happy, injection, duplicate, over-contract,
                            # uncredentialed, address-swap, over-limit, kill-switch, escrow (simulated)
npm run demo happy          # one autonomous 12.50 RLUSD payment; prints the explorer link
npm run agent:status        # signer list + master key, read from the ledger
npm run onboard -- np_1     # Nessie bank check + signed wallet challenge + on-ledger credential
npm run test:checks         # 186 offline guardrail tests
npm run redteam             # live co-signer refusals; nothing submitted
npm run golden-path         # end to end: reset → pay → live pin update → injection refused → reset
```

**iMessage line:** runs in dry-run mode (logs instead of sending) until Photon keys are set in `imessage/.env`. Setup: [`context.md`](context.md#imessage-via-photon-imessage).

```bash
cd imessage && npm install && npm run dev   # http://localhost:4003/health
```

## Secrets

- Shared config and API keys: repo-root `.env` (gitignored). Template: [`.env.example`](.env.example).
- XRPL seeds: `xrpl/.env.local` (setup accounts) and `xrpl/.env.agent`, `xrpl/.env.cosigner`, `xrpl/.env.officer` (one signer per process). All gitignored.
- XRPL is **Testnet only**. Testnet tokens have no value.

## What's real, what's Testnet, what's simulated

- **Real public records:** the 15 nonprofits on the map, their contracts, IRS 990 cash, agency lateness (Comptroller), and Checkbook NYC payments for Food Bank For NYC. Every record carries `source` + `source_url`. Only the Food Bank has payment records loaded so far; the other 14 are scored on 3 of 4 factors and say so.
- **Real Testnet transactions (no monetary value):** every agent payment, the multisig setup, credentials, the kill switch and escrow. Amounts are Testnet scale (auto-limit 25 RLUSD).
- **Simulated and labeled (`is_demo_data: true`):** invoices, events, the exclusion list, the 4 fictional demo nonprofits, the nonprofit's side of onboarding, the "hacked agent" steps, and escrow (a city test token, because RLUSD escrow is blocked on Testnet). Test payments move a what-if score shown only on `/demo`, at a disclosed scale (1 RLUSD = $10,000); they never change `/map`.
- The three signers run as separate processes with separate keys on one laptop, not separate machines.

## Built with

Next.js · React · Tailwind CSS · Leaflet / OpenStreetMap · Fastify · TypeScript · Python · MongoDB Atlas · XRP Ledger (xrpl.js, RLUSD, XLS-70 credentials, multisig) · Grok (xAI) · Photon Spectrum (iMessage) · Capital One Nessie · Checkbook NYC · NYC Open Data · ProPublica Nonprofit Explorer

## Team

- Noel K ([@3olt](https://github.com/3olt)): frontend and the iMessage line
- Gagan ([@GaganGutta](https://github.com/GaganGutta)): backend, API, XRPL agent, data pipeline, open data page

## License

[MIT](LICENSE)
