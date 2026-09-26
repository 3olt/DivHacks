"use client";

// /data: the open database behind GlassLedger. Every record the API serves (sites, nonprofits, contracts, payments,
// decisions, agencies) plus the REAL XRPL Testnet activity and accounts, read straight from the ledger.
import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { API_URL } from "@/lib/api";
import { XRPL_TESTNET_WS, explorerAccountUrl, type AccountState, type Registry } from "@/lib/ledger";
import { loadHealth, loadOpenData, loadRegistry, type Health, type OpenDataset } from "@/lib/openData";
import { RISK_COLORS } from "@/lib/risk";
import { Badge, ExtLink } from "./cells";
import { AccountsTable, AgenciesTable, ContractsTable, DecisionsTable, NonprofitsTable, OnChainTable, PaymentsTable, SitesTable, fmtTime } from "./tables";
import { useLedger, type LedgerView } from "./useLedger";

type Loadable<T> = { phase: "loading" } | { phase: "ready"; data: T } | { phase: "error"; error: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs `load` once per `key`; state is tagged with the key so a new key reads as "loading" immediately. */
function useLoad<T>(load: () => Promise<T>, key: string): Loadable<T> {
  const [state, setState] = useState<{ key: string; result: Loadable<T> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => !cancelled && setState({ key, result: { phase: "ready", data } }),
      (e: unknown) => !cancelled && setState({ key, result: { phase: "error", error: message(e) } }),
    );
    return () => {
      cancelled = true;
    };
  }, [load, key]);
  return state && state.key === key ? state.result : { phase: "loading" };
}

const fetchHealth = () => loadHealth(API_URL);
const fetchDataset = () => loadOpenData(API_URL);
const fetchRegistry = () => loadRegistry(API_URL);

type TabId = "sites" | "nonprofits" | "contracts" | "payments" | "decisions" | "agencies" | "onchain" | "accounts";

const TABS: { id: TabId; label: string; real?: boolean }[] = [
  { id: "sites", label: "Sites" },
  { id: "nonprofits", label: "Nonprofits" },
  { id: "contracts", label: "Contracts" },
  { id: "payments", label: "Payments" },
  { id: "decisions", label: "Decisions" },
  { id: "agencies", label: "Agencies" },
  { id: "onchain", label: "On-chain", real: true },
  { id: "accounts", label: "Accounts", real: true },
];

export default function OpenDataPage() {
  const [tab, setTab] = useState<TabId>("sites");
  const [apiAttempt, setApiAttempt] = useState(0);
  const [regAttempt, setRegAttempt] = useState(0);
  const [ledgerAttempt, setLedgerAttempt] = useState(0);

  const health = useLoad<Health>(fetchHealth, `health#${apiAttempt}`);
  const dataset = useLoad<OpenDataset>(fetchDataset, `data#${apiAttempt}`);
  const registry = useLoad<Registry>(fetchRegistry, `registry#${regAttempt}`);
  const ledger = useLedger(registry.phase === "ready" ? registry.data : null, ledgerAttempt);

  const mode = health.phase === "ready" ? health.data.mode : null;
  const fixtureMode = mode === "fixtures";

  const reconnectLedger = () => {
    if (registry.phase === "error") setRegAttempt((n) => n + 1);
    setLedgerAttempt((n) => n + 1);
  };
  // Reloading the API data also retries the registry if it failed (the ledger tabs depend on it).
  const retryApi = () => {
    setApiAttempt((n) => n + 1);
    if (registry.phase === "error") setRegAttempt((n) => n + 1);
  };

  const count = (id: TabId): { text: string; label: string } => {
    const failed = { text: "!", label: "failed to load" };
    const loading = { text: "…", label: "loading" };
    if (id === "onchain" || id === "accounts") {
      if (registry.phase === "error") return failed;
      const phase = id === "onchain" ? ledger.txPhase : ledger.accPhase;
      if (phase === "error") return failed;
      if (phase !== "ready") return loading;
      const n = id === "onchain" ? ledger.txs.length : ledger.accounts.length;
      return { text: String(n), label: `${n} rows` };
    }
    if (dataset.phase === "loading") return loading;
    if (dataset.phase === "error") return failed;
    const n = dataset.data[id].length;
    return { text: String(n), label: `${n} rows` };
  };

  // WAI-ARIA tabs: arrow keys / Home / End move between tabs; only the active tab is in the Tab order.
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const id = TABS[next].id;
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <div className="min-h-dvh bg-white text-gray-900">
      <header className="border-b border-gray-200">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span className="flex gap-0.5" aria-hidden>
              {(["green", "yellow", "red"] as const).map((l) => (
                <span key={l} className="h-2.5 w-2.5 rounded-full" style={{ background: RISK_COLORS[l] }} />
              ))}
            </span>
            GlassLedger
          </Link>
          <nav className="flex items-center gap-4 text-sm" aria-label="Pages">
            <Link href="/" className="text-gray-600 hover:text-gray-900">
              Home
            </Link>
            <Link href="/map" className="text-gray-600 hover:text-gray-900">
              Map
            </Link>
            <span aria-current="page" className="font-medium text-gray-900">
              Open data
            </span>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">Open data</h1>
            <ModeBadge health={health} />
          </div>
          <p className="max-w-3xl text-gray-600">
            Every record behind the map, in plain tables: the sites, the nonprofits that run them, their city contracts and payments, the payment agent&apos;s decisions, and the agent&apos;s real transactions on the XRP Ledger. Search or sort any table, click a row to see the full record, and download what you see as JSON or CSV.
          </p>
          <p className="text-xs text-gray-500">
            API <span className="font-mono">{API_URL}</span>
            {dataset.phase === "ready" && <> · loaded {fmtTime(dataset.data.loaded_at)}</>} · ledger <span className="font-mono">{XRPL_TESTNET_WS}</span> ·{" "}
            <button type="button" onClick={retryApi} className="rounded-sm font-medium text-gray-700 underline hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
              Reload API data
            </button>
          </p>
          <HonestyBanner health={health} />
        </section>

        <div role="tablist" aria-label="Datasets" className="flex flex-wrap gap-x-1 border-b border-gray-200">
          {TABS.map((t) => {
            const active = tab === t.id;
            const c = count(t.id);
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                id={`tab-${t.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="data-tabpanel"
                tabIndex={active ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={onTabKey}
                className={`-mb-px flex shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gray-900 ${active ? "border-gray-900 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-900"}`}
              >
                {t.label}
                <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${active ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600"}`}>
                  <span aria-hidden>{c.text}</span>
                  <span className="sr-only">, {c.label}</span>
                </span>
                {t.id === "onchain" && ledger.live === "live" && (
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" title="Live">
                    <span className="sr-only">, live</span>
                  </span>
                )}
                {t.real && (
                  <span className="text-[10px] font-semibold uppercase text-green-700" title="Read live from XRPL Testnet (real transactions; Testnet money has no value)">
                    testnet
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <section id="data-tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0} className="focus-visible:outline-none">
          {tab === "onchain" ? (
            <OnChainPanel registry={registry} ledger={ledger} onReconnect={reconnectLedger} />
          ) : tab === "accounts" ? (
            <AccountsPanel registry={registry} ledger={ledger} onReconnect={reconnectLedger} />
          ) : (
            <ApiPanel dataset={dataset} tab={tab} fixtureMode={fixtureMode} onRetry={retryApi} />
          )}
        </section>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ModeBadge({ health }: { health: Loadable<Health> }) {
  if (health.phase === "loading") return <Badge>checking API…</Badge>;
  if (health.phase === "error") return <Badge tone="red" title={health.error}>API unreachable</Badge>;
  return health.data.mode === "fixtures" ? (
    <Badge tone="amber" title={`GET /health: mode "fixtures", version ${health.data.version}`}>
      API mode: fixtures (demo data)
    </Badge>
  ) : (
    <Badge tone={health.data.mode === "mongo" ? "green" : "gray"} title={`GET /health: mode "${health.data.mode}", version ${health.data.version}`}>
      API mode: {health.data.mode}
    </Badge>
  );
}

function HonestyBanner({ health }: { health: Loadable<Health> }) {
  const real = (
    <p>
      <span className="font-semibold">Real ledger, test money:</span> the <span className="font-medium">On-chain</span> and <span className="font-medium">Accounts</span> tabs are read live from the XRP Ledger <span className="font-medium">Testnet</span> by your browser; the API only supplies the list of public addresses to read. The transactions and balances are real Testnet records, but Testnet tokens have no value and the payees are the fictional fixture nonprofits, so these rows are flagged <span className="font-mono">is_demo_data</span> too.
    </p>
  );
  if (health.phase === "error") {
    return (
      <div className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
        <p>
          <span className="font-semibold">The API did not answer</span> ({health.error}). Start it with <span className="font-mono">npm run dev:api</span> or set <span className="font-mono">NEXT_PUBLIC_API_URL</span>. The ledger tabs need its account registry (<span className="font-mono">GET /xrpl/accounts</span>) to know which accounts to read.
        </p>
      </div>
    );
  }
  if (health.phase === "ready" && health.data.mode === "fixtures") {
    return (
      <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
        <p>
          <span className="font-semibold">Demo data:</span> the API is in fixture mode, so the sites, nonprofits, contracts, city (Checkbook-style) payments, agency stats and agent decisions below are fictional records flagged <span className="font-mono">is_demo_data</span> (organization names end in “(demo)”, wallet addresses are placeholders, and tx hashes starting <span className="font-mono">00000000FA15E</span> are fake). They are replaced when the real Checkbook NYC, Comptroller and ProPublica 990 data lands. Street addresses are real NYC addresses used only to place pins.
        </p>
        <div className="text-green-900">{real}</div>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-800">
      <p>Public records carry their <span className="font-mono">source</span> and a link to it; anything seeded or simulated is flagged <span className="font-medium">demo</span>.</p>
      {real}
    </div>
  );
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-6 text-sm text-gray-600">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900" aria-hidden />
      {children}
    </div>
  );
}

function ErrorBox({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 font-mono text-xs">{detail}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

const RetryButton = ({ onClick, children = "Try again" }: { onClick: () => void; children?: ReactNode }) => (
  <button
    type="button"
    onClick={onClick}
    className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-800 hover:border-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
  >
    {children}
  </button>
);

const API_TAB_NOTES: Record<Exclude<TabId, "onchain" | "accounts">, ReactNode> = {
  sites: (
    <>
      Every map pin, from <span className="font-mono">GET /sites</span>. The risk score is an explainable formula, not a trained model: expand a row for its <span className="font-mono">reasons</span>.
    </>
  ),
  nonprofits: (
    <>
      The organizations behind the sites, from each site&apos;s money trail (<span className="font-mono">GET /sites/:id/trail</span>), one row per EIN. Financials are IRS 990 figures in USD.
    </>
  ),
  contracts: (
    <>
      City contracts from every site&apos;s money trail, one row per <span className="font-mono">contract_id</span>. Amounts are USD.
    </>
  ),
  payments: (
    <>
      The money timeline from every trail, one row per <span className="font-mono">payment_id</span>: city (Checkbook) payments in USD and the agent&apos;s XRPL payment attempts in RLUSD, including refused ones. In fixture mode the XRPL rows are fixtures too (fake tx hashes, not linked); the agent&apos;s real Testnet payments are in the On-chain tab.
    </>
  ),
  decisions: (
    <>
      Every payment decision the agent made (<span className="font-mono">GET /decisions?limit=200</span> plus the trails), newest first. Checks are the co-signer&apos;s 8 independent checks, in order: credential, registry wallet, not already paid, contract amount, auto limit, daily caps, not excluded, tx format. Hover a dot for its detail.
    </>
  ),
  agencies: (
    <>
      Agency-level contract lateness, from <span className="font-mono">GET /agencies/:code/stats</span> for every agency code seen on a site or contract.
    </>
  ),
};

function ApiPanel({ dataset, tab, fixtureMode, onRetry }: { dataset: Loadable<OpenDataset>; tab: Exclude<TabId, "onchain" | "accounts">; fixtureMode: boolean; onRetry: () => void }) {
  if (dataset.phase === "loading") return <Loading>Loading every site and its money trail from the API…</Loading>;
  if (dataset.phase === "error") {
    return <ErrorBox title={`Could not load the records from ${API_URL}`} detail={dataset.error} action={<RetryButton onClick={onRetry} />} />;
  }
  const d = dataset.data;
  return (
    <div className="space-y-3">
      <p className="max-w-4xl text-sm text-gray-600">{API_TAB_NOTES[tab]}</p>
      {tab === "decisions" && fixtureMode && (
        <p className="max-w-4xl rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          These decisions are fixtures (<span className="font-mono">rule_version fixture-0</span>, fake tx hashes). The agent&apos;s real Testnet payments are in the On-chain tab.
        </p>
      )}
      {d.warnings.length > 0 && (
        <details className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <summary className="cursor-pointer font-medium">{d.warnings.length} request(s) failed; the tables may be incomplete</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono">
            {d.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      {tab === "sites" && <SitesTable sites={d.sites} nonprofits={d.nonprofits} />}
      {tab === "nonprofits" && <NonprofitsTable nonprofits={d.nonprofits} sites={d.sites} fixtureMode={fixtureMode} />}
      {tab === "contracts" && <ContractsTable contracts={d.contracts} nonprofits={d.nonprofits} />}
      {tab === "payments" && <PaymentsTable payments={d.payments} />}
      {tab === "decisions" && <DecisionsTable decisions={d.decisions} />}
      {tab === "agencies" && <AgenciesTable agencies={d.agencies} />}
    </div>
  );
}

function LiveIndicator({ ledger, onReconnect }: { ledger: LedgerView; onReconnect: () => void }) {
  const status =
    ledger.live === "live" ? (
      <span className="inline-flex items-center gap-1.5 font-medium text-green-700" title="Subscribed to the account stream: new validated transactions appear here without a reload">
        <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
        live
        {ledger.reconnects > 0 && <span className="font-normal text-gray-500">(reconnected {ledger.reconnects}×)</span>}
      </span>
    ) : ledger.live === "connecting" ? (
      <span className="inline-flex items-center gap-1.5 text-gray-600">
        <span aria-hidden className="h-2 w-2 animate-spin rounded-full border border-gray-300 border-t-gray-900" />
        connecting…
      </span>
    ) : ledger.live === "reconnecting" ? (
      <span className="inline-flex items-center gap-1.5 text-amber-800" title={ledger.liveError ?? undefined}>
        <span aria-hidden className="h-2 w-2 rounded-full bg-amber-500" />
        connection lost · retrying{ledger.retryAt ? ` at ${new Date(ledger.retryAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : ""}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-gray-500" title={ledger.liveError ?? undefined}>
        <span aria-hidden className="h-2 w-2 rounded-full bg-gray-300" />
        {ledger.live === "closed" ? "disconnected" : "not live"}
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs" role="status" aria-live="polite">
      {status}
      {ledger.lastEventAt && <span className="text-gray-500">last update {fmtTime(ledger.lastEventAt)}</span>}
      {(ledger.live === "reconnecting" || ledger.live === "closed" || ledger.live === "off") && (
        <RetryButton onClick={onReconnect}>{ledger.live === "reconnecting" ? "Reconnect now" : "Reconnect"}</RetryButton>
      )}
    </span>
  );
}

function RegistryGate({ registry, onReconnect, children }: { registry: Loadable<Registry>; onReconnect: () => void; children: (reg: Registry) => ReactNode }) {
  if (registry.phase === "loading") return <Loading>Loading the account registry (GET /xrpl/accounts)…</Loading>;
  if (registry.phase === "error") {
    return (
      <ErrorBox
        title="Could not load the XRPL account registry from the API, so there is no account to read"
        detail={registry.error}
        action={<RetryButton onClick={onReconnect} />}
      />
    );
  }
  return <>{children(registry.data)}</>;
}

function OnChainPanel({ registry, ledger, onReconnect }: { registry: Loadable<Registry>; ledger: LedgerView; onReconnect: () => void }) {
  return (
    <RegistryGate registry={registry} onReconnect={onReconnect}>
      {(reg) => (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-4xl text-sm text-gray-600">
              <Badge tone="green">real · XRPL Testnet</Badge>{" "}
              Every transaction on the agent&apos;s multisig account{" "}
              <ExtLink href={explorerAccountUrl(reg.agent_account)} mono>
                {reg.agent_account}
              </ExtLink>
              , read straight from the ledger (<span className="font-mono">account_tx</span>), newest first. It includes the setup transactions (TrustSet, SignerListSet, AccountSet disabling the master key). Payment memos are decoded to <span className="font-mono">{"{inv, ctr, ein, dh, rv}"}</span>; <span className="font-mono">dh</span> is the decision hash. Payments the co-signer refused were never signed, and ledger refusals such as <span className="font-mono">tefBAD_QUORUM</span> never reach a ledger, so neither can appear here (see Decisions).
            </p>
            <LiveIndicator ledger={ledger} onReconnect={onReconnect} />
          </div>
          {ledger.txPhase === "error" ? (
            <ErrorBox
              title={ledger.live === "reconnecting" || ledger.live === "connecting" ? "Could not read the ledger yet; retrying automatically" : "Could not read the ledger"}
              detail={ledger.txError ?? "unknown error"}
              action={<RetryButton onClick={onReconnect}>Reconnect now</RetryButton>}
            />
          ) : ledger.txPhase !== "ready" ? (
            <Loading>Reading agent_account&apos;s transactions from XRPL Testnet…</Loading>
          ) : (
            <>
              {ledger.truncated && <p className="text-xs text-gray-500">Showing the newest {ledger.txs.length} transactions; older ones are on the explorer.</p>}
              <OnChainTable txs={ledger.txs} />
            </>
          )}
        </div>
      )}
    </RegistryGate>
  );
}

function SignerListSummary({ agent, reg }: { agent: AccountState | undefined; reg: Registry }) {
  if (!agent) return null;
  const list = agent.signer_list;
  const matches =
    list !== null &&
    list.quorum === reg.quorum &&
    Object.values(reg.signers).every((s) => list.entries.some((e) => e.address === s.address && e.weight === s.weight)) &&
    list.entries.length === Object.keys(reg.signers).length;
  const weightOf = (role: string) => list?.entries.find((e) => e.role === role)?.weight ?? 0;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-lg border border-gray-200 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Signer list on the ledger</p>
        {list ? (
          <>
            <ul className="mt-2 space-y-0.5 text-sm">
              {list.entries.map((e) => (
                <li key={e.address} className="flex justify-between gap-2">
                  <span className="font-medium">{e.role ?? <span className="font-mono text-xs">{e.address}</span>}</span>
                  <span className="tabular-nums text-gray-600">weight {e.weight}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm">
              Quorum <span className="font-semibold tabular-nums">{list.quorum}</span>{" "}
              {matches ? <Badge tone="green">matches the registry</Badge> : <Badge tone="red">differs from the registry</Badge>}
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-gray-600">{agent.status === "ok" ? "No signer list set." : "Not available."}</p>
        )}
      </div>
      <div className="rounded-lg border border-gray-200 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">agent_account master key</p>
        <p className="mt-2 text-sm">
          {agent.master_disabled === null ? (
            "Not available."
          ) : agent.master_disabled ? (
            <>
              <Badge tone="green">disabled</Badge> <span className="text-gray-700">(lsfDisableMaster is set): only the signer list can sign.</span>
            </>
          ) : (
            <>
              <Badge tone="red">enabled</Badge> <span className="text-gray-700">the master key can still sign alone.</span>
            </>
          )}
        </p>
      </div>
      <div className="rounded-lg border border-gray-200 p-4 text-sm text-gray-700">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">What the ledger enforces</p>
        {list ? (
          <ul className="mt-2 space-y-0.5">
            <li>
              agent alone: weight {weightOf("agent")} &lt; {list.quorum} → refused (<span className="font-mono text-xs">tefBAD_QUORUM</span>)
            </li>
            <li>
              agent + cosigner: {weightOf("agent") + weightOf("cosigner")} ≥ {list.quorum} → pays, no human
            </li>
            <li>
              agent + cosigner + officer: {weightOf("agent") + weightOf("cosigner") + weightOf("officer")} → over-limit payments
            </li>
          </ul>
        ) : (
          <p className="mt-2">Not available.</p>
        )}
      </div>
    </div>
  );
}

function AccountsPanel({ registry, ledger, onReconnect }: { registry: Loadable<Registry>; ledger: LedgerView; onReconnect: () => void }) {
  return (
    <RegistryGate registry={registry} onReconnect={onReconnect}>
      {(reg) => (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-4xl text-sm text-gray-600">
              <Badge tone="green">real · XRPL Testnet</Badge> Every account in the public registry (<span className="font-mono">GET /xrpl/accounts</span>, network{" "}
              <span className="font-mono">{reg.network}</span>) with its live balances from <span className="font-mono">account_info</span> and <span className="font-mono">account_lines</span>. The three signer keys are unfunded keypairs, not accounts: they can only sign for agent_account through its signer list. The np_1..np_4 names are the fictional fixture nonprofits; their Testnet accounts and balances are real, but Testnet tokens have no value.
            </p>
            <LiveIndicator ledger={ledger} onReconnect={onReconnect} />
          </div>
          {ledger.accPhase === "error" ? (
            <ErrorBox
              title={ledger.live === "reconnecting" || ledger.live === "connecting" ? "Could not read the accounts yet; retrying automatically" : "Could not read the accounts from the ledger"}
              detail={ledger.accError ?? "unknown error"}
              action={<RetryButton onClick={onReconnect}>Reconnect now</RetryButton>}
            />
          ) : ledger.accPhase !== "ready" ? (
            <Loading>Reading balances and the signer list from XRPL Testnet…</Loading>
          ) : (
            <>
              <SignerListSummary agent={ledger.accounts.find((a) => a.kind === "multisig_account")} reg={reg} />
              <AccountsTable accounts={ledger.accounts} />
            </>
          )}
        </div>
      )}
    </RegistryGate>
  );
}
