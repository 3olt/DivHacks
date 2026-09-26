"use client";

// Column definitions for every open-data tab. Each table shows the records as the API / ledger returns them.
import { useMemo } from "react";
import type { AgencyStats, Contract, Decision, Nonprofit, Payment, Site } from "@/lib/contracts";
import { SITE_TYPE_LABELS, enforcedByLabel, refusalLabel } from "@/lib/format";
import type { AccountState, LedgerTxRow } from "@/lib/ledger";
import { daysBetween, isDemoContract, isFixtureDecision, toTime } from "@/lib/openData";
import { AccountLink, Badge, CheckDots, DemoBadge, Empty, ExtLink, Mono, Money, OutcomeBadge, ResultBadge, RiskCell, SourceLink, TxHash } from "./cells";
import DataTable, { type Column } from "./DataTable";

/** Full timestamp -> "Sep 26, 2026, 1:41 PM ET" (New York). */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
}

const num = (s: string | null | undefined) => (s === null || s === undefined || s === "" ? null : Number(s));
const pct = (x: number | null) => (x === null ? "" : `${Math.round(x * 100)}%`);

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export function SitesTable({ sites, nonprofits }: { sites: Site[]; nonprofits: Nonprofit[] }) {
  const columns = useMemo<Column<Site>[]>(() => {
    const npName = new Map(nonprofits.map((n) => [n.ein, n.name]));
    return [
      { key: "id", label: "ID", value: (s) => s.id, render: (s) => <Mono>{s.id}</Mono> },
      {
        key: "name",
        label: "Name",
        value: (s) => s.name,
        render: (s) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-gray-900">{s.name}</span>
            {s.is_demo_data && <DemoBadge />}
          </span>
        ),
        className: "min-w-56",
      },
      { key: "type", label: "Type", value: (s) => SITE_TYPE_LABELS[s.type] ?? s.type, className: "whitespace-nowrap" },
      { key: "borough", label: "Borough", value: (s) => s.borough, className: "whitespace-nowrap" },
      { key: "zip", label: "ZIP", value: (s) => s.zip },
      { key: "address", label: "Address", value: (s) => s.address ?? null, className: "min-w-48 text-gray-700" },
      { key: "agency", label: "Agency", value: (s) => s.agency_code },
      {
        key: "nonprofit",
        label: "Nonprofit",
        value: (s) => `${s.nonprofit_ein} ${npName.get(s.nonprofit_ein) ?? ""}`,
        render: (s) => (
          <span>
            <Mono>{s.nonprofit_ein}</Mono>
            {npName.get(s.nonprofit_ein) && <span className="block text-xs text-gray-600">{npName.get(s.nonprofit_ein)}</span>}
          </span>
        ),
        className: "min-w-48",
      },
      { key: "contracts", label: "Contracts", value: (s) => s.contract_ids.join(", "), render: (s) => <Mono>{s.contract_ids.join(", ")}</Mono> },
      { key: "risk", label: "Risk", value: (s) => s.risk.score, render: (s) => <RiskCell level={s.risk.level} score={s.risk.score} />, title: "Risk score 0-100 (hover for the level label); expand the row for the reasons" },
      { key: "summary", label: "Why", value: (s) => s.risk.summary, className: "min-w-72 text-xs text-gray-700" },
      {
        key: "event",
        label: "Next event",
        value: (s) => toTime(s.events[0]?.starts_at),
        render: (s) =>
          s.events[0] ? (
            <span className="text-xs">
              {s.events[0].title}
              <span className="block text-gray-500">{fmtTime(s.events[0].starts_at)}</span>
            </span>
          ) : (
            <Empty />
          ),
        className: "min-w-48",
      },
      {
        key: "lnglat",
        label: "Lat, lng",
        value: (s) => `${s.location.coordinates[1]}, ${s.location.coordinates[0]}`,
        render: (s) => <Mono>{`${s.location.coordinates[1]}, ${s.location.coordinates[0]}`}</Mono>,
        className: "whitespace-nowrap",
      },
    ];
  }, [nonprofits]);
  return <DataTable id="sites" label="sites" rows={sites} columns={columns} rowKey={(s) => s.id} empty="The API returned no sites." />;
}

// ---------------------------------------------------------------------------
// Nonprofits
// ---------------------------------------------------------------------------

export function NonprofitsTable({ nonprofits, sites, fixtureMode }: { nonprofits: Nonprofit[]; sites: Site[]; fixtureMode: boolean }) {
  const columns = useMemo<Column<Nonprofit>[]>(() => {
    const sitesByEin = new Map<string, Site[]>();
    for (const s of sites) sitesByEin.set(s.nonprofit_ein, [...(sitesByEin.get(s.nonprofit_ein) ?? []), s]);
    const isDemo = (n: Nonprofit) => /\(demo\)/i.test(n.name) || (sitesByEin.get(n.ein) ?? []).some((s) => s.is_demo_data);
    return [
      { key: "ein", label: "EIN", value: (n) => n.ein, render: (n) => <Mono>{n.ein}</Mono> },
      {
        key: "name",
        label: "Name",
        value: (n) => n.name,
        render: (n) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-gray-900">{n.name}</span>
            {isDemo(n) && <DemoBadge title="Fictional fixture organization (name ends in “(demo)”)" />}
          </span>
        ),
        className: "min-w-56",
      },
      { key: "address", label: "Address", value: (n) => n.address, className: "min-w-48 text-gray-700" },
      { key: "services", label: "Services", value: (n) => n.service_types.map((t) => SITE_TYPE_LABELS[t as Site["type"]] ?? t).join(", "), className: "whitespace-nowrap" },
      { key: "sites", label: "Sites", value: (n) => (sitesByEin.get(n.ein) ?? []).map((s) => s.id).join(", "), render: (n) => <Mono>{(sitesByEin.get(n.ein) ?? []).map((s) => s.id).join(", ")}</Mono> },
      { key: "fy", label: "990 FY", value: (n) => n.financials?.fiscal_year ?? null, render: (n) => (n.financials ? n.financials.fiscal_year : <span className="text-xs text-gray-500">No 990 on file</span>) },
      { key: "revenue", label: "Revenue", value: (n) => n.financials?.revenue ?? null, render: (n) => (n.financials ? <Money amount={String(n.financials.revenue)} currency="USD" /> : <Empty />), align: "right" },
      { key: "expenses", label: "Expenses", value: (n) => n.financials?.expenses ?? null, render: (n) => (n.financials ? <Money amount={String(n.financials.expenses)} currency="USD" /> : <Empty />), align: "right" },
      { key: "net_assets", label: "Net assets", value: (n) => n.financials?.net_assets ?? null, render: (n) => (n.financials ? <Money amount={String(n.financials.net_assets)} currency="USD" /> : <Empty />), align: "right" },
      { key: "cash", label: "Cash (months)", value: (n) => n.financials?.cash_months ?? null, align: "right" },
      {
        key: "wallet",
        label: "Wallet",
        value: (n) => n.wallet?.address ?? null,
        render: (n) =>
          n.wallet ? (
            <Mono title={fixtureMode ? "Fixture placeholder address: checksum-valid but not on Testnet, and no key exists for it" : n.wallet.address}>
              {n.wallet.address.slice(0, 8)}…{n.wallet.address.slice(-4)}
              {fixtureMode && <span className="ml-1 font-sans text-[11px] text-gray-500">(placeholder)</span>}
            </Mono>
          ) : (
            <span className="text-xs text-gray-500">none registered</span>
          ),
        className: "whitespace-nowrap",
      },
      {
        key: "credential",
        label: "Credential",
        value: (n) => n.wallet?.credential_status ?? null,
        render: (n) =>
          !n.wallet ? (
            <Empty />
          ) : n.wallet.credential_status === "valid" ? (
            <Badge tone="green" title={`valid until ${n.wallet.credential_expires ?? "?"}`}>
              valid
            </Badge>
          ) : n.wallet.credential_status === "expired" ? (
            <Badge tone="red">expired</Badge>
          ) : (
            <Badge>none</Badge>
          ),
      },
      { key: "bank", label: "Bank verified", value: (n) => (n.wallet ? (n.wallet.bank_verified ? "yes" : "no") : null) },
      { key: "source", label: "990 source", value: (n) => n.financials?.source_url ?? null, render: (n) => <SourceLink url={n.financials?.source_url} source="IRS 990 via ProPublica Nonprofit Explorer" /> },
    ];
  }, [sites, fixtureMode]);
  return <DataTable id="nonprofits" label="nonprofits" rows={nonprofits} columns={columns} rowKey={(n) => n.ein} empty="No nonprofits (no site trail loaded)." />;
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export function ContractsTable({ contracts, nonprofits }: { contracts: Contract[]; nonprofits: Nonprofit[] }) {
  const columns = useMemo<Column<Contract>[]>(() => {
    const npName = new Map(nonprofits.map((n) => [n.ein, n.name]));
    const spentPct = (c: Contract) => {
      const a = num(c.amount);
      const s = num(c.spent_to_date);
      return a && s !== null ? s / a : null;
    };
    const lateDays = (c: Contract) => (c.registered_date ? daysBetween(c.start_date, c.registered_date) : null);
    return [
      {
        key: "contract_id",
        label: "Contract",
        value: (c) => c.contract_id,
        render: (c) => (
          <span className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
            <Mono>{c.contract_id}</Mono>
            {isDemoContract(c) && <DemoBadge title={c.source} />}
          </span>
        ),
      },
      { key: "agency", label: "Agency", value: (c) => c.agency_code },
      {
        key: "nonprofit",
        label: "Nonprofit",
        value: (c) => `${c.nonprofit_ein} ${npName.get(c.nonprofit_ein) ?? ""}`,
        render: (c) => (
          <span>
            <Mono>{c.nonprofit_ein}</Mono>
            {npName.get(c.nonprofit_ein) && <span className="block text-xs text-gray-600">{npName.get(c.nonprofit_ein)}</span>}
          </span>
        ),
        className: "min-w-48",
      },
      { key: "purpose", label: "Purpose", value: (c) => c.purpose ?? null, className: "min-w-64 text-xs text-gray-700" },
      { key: "amount", label: "Amount", value: (c) => num(c.amount), render: (c) => <Money amount={c.amount} currency="USD" />, align: "right" },
      { key: "spent", label: "Spent to date", value: (c) => num(c.spent_to_date), render: (c) => <Money amount={c.spent_to_date} currency="USD" />, align: "right" },
      { key: "spent_pct", label: "% spent", value: spentPct, render: (c) => pct(spentPct(c)), align: "right" },
      { key: "start", label: "Start", value: (c) => c.start_date, className: "whitespace-nowrap" },
      { key: "end", label: "End", value: (c) => c.end_date, className: "whitespace-nowrap" },
      {
        key: "registered",
        label: "Registered",
        value: (c) => c.registered_date,
        render: (c) => (c.registered_date ? c.registered_date : <Badge tone="red">unregistered</Badge>),
        className: "whitespace-nowrap",
      },
      { key: "late", label: "Days late", value: lateDays, title: "Days between the contract start and its registration", align: "right" },
      { key: "source", label: "Source", value: (c) => `${c.source} ${c.source_url}`, render: (c) => <SourceLink url={c.source_url} source={c.source} /> },
    ];
  }, [nonprofits]);
  return <DataTable id="contracts" label="contracts" rows={contracts} columns={columns} rowKey={(c) => c.contract_id} empty="No contracts in any site trail." />;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const PAYMENT_STATUS_TONE: Record<Payment["status"], "green" | "red" | "amber" | "blue"> = {
  released: "green",
  refused: "red",
  pending_approval: "amber",
  held_escrow: "blue",
};

const PAYMENT_COLUMNS: Column<Payment>[] = [
  { key: "date", label: "Date", value: (p) => toTime(p.date), render: (p) => (/^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : fmtTime(p.date)), className: "whitespace-nowrap" },
  {
    key: "payment_id",
    label: "Payment",
    value: (p) => p.payment_id,
    render: (p) => (
      <span className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
        <Mono>{p.payment_id}</Mono>
        {p.is_demo_data && <DemoBadge />}
      </span>
    ),
  },
  { key: "source", label: "Source", value: (p) => p.source, render: (p) => <Badge tone={p.source === "xrpl" ? "blue" : "gray"}>{p.source === "xrpl" ? "XRPL agent" : "Checkbook"}</Badge> },
  { key: "contract", label: "Contract", value: (p) => p.contract_id, render: (p) => <Mono>{p.contract_id}</Mono> },
  { key: "payee", label: "Payee EIN", value: (p) => p.payee_ein, render: (p) => <Mono>{p.payee_ein}</Mono> },
  { key: "amount", label: "Amount", value: (p) => num(p.amount), render: (p) => <Money amount={p.amount} currency={p.currency} />, align: "right" },
  { key: "status", label: "Status", value: (p) => p.status, render: (p) => <Badge tone={PAYMENT_STATUS_TONE[p.status] ?? "gray"}>{p.status}</Badge> },
  { key: "invoice", label: "Invoice", value: (p) => p.invoice_id ?? null, render: (p) => (p.invoice_id ? <Mono>{p.invoice_id}</Mono> : <Empty />) },
  { key: "tx", label: "XRPL tx", value: (p) => p.xrpl_tx_hash ?? null, render: (p) => <TxHash hash={p.xrpl_tx_hash} /> },
  {
    key: "memo_hash",
    label: "Memo hash",
    value: (p) => p.memo_hash ?? null,
    render: (p) => (p.memo_hash ? <Mono title={`SHA-256 of the on-ledger MemoData JSON: ${p.memo_hash}`}>{p.memo_hash.slice(0, 10)}…</Mono> : <Empty />),
  },
];

export function PaymentsTable({ payments }: { payments: Payment[] }) {
  return <DataTable id="payments" label="payments" rows={payments} columns={PAYMENT_COLUMNS} rowKey={(p) => p.payment_id} initialSort={{ key: "date", dir: "desc" }} empty="No payments in any site trail." />;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

const DECISION_COLUMNS: Column<Decision>[] = [
  { key: "created", label: "Created", value: (d) => toTime(d.created_at), render: (d) => fmtTime(d.created_at), className: "whitespace-nowrap" },
  {
    key: "decision_id",
    label: "Decision",
    value: (d) => d.decision_id,
    render: (d) => (
      <span className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
        <Mono>{d.decision_id}</Mono>
        {isFixtureDecision(d) && <DemoBadge title={`Fixture decision (rule_version ${d.rule_version}); not an on-ledger event`} />}
      </span>
    ),
  },
  { key: "outcome", label: "Outcome", value: (d) => d.outcome, render: (d) => <OutcomeBadge outcome={d.outcome} /> },
  { key: "amount", label: "Amount", value: (d) => num(d.amount), render: (d) => <Money amount={d.amount} currency={d.currency} />, align: "right" },
  { key: "invoice", label: "Invoice", value: (d) => d.invoice_id, render: (d) => <Mono>{d.invoice_id}</Mono> },
  { key: "contract", label: "Contract", value: (d) => d.contract_id, render: (d) => <Mono>{d.contract_id}</Mono> },
  { key: "payee", label: "Payee EIN", value: (d) => d.payee_ein, render: (d) => <Mono>{d.payee_ein}</Mono> },
  {
    key: "reasons",
    label: "Refusal reasons",
    value: (d) => d.refusal_reasons.map((r) => `${refusalLabel(r)} (${r})`).join("; ") || null,
    render: (d) =>
      d.refusal_reasons.length === 0 ? (
        <Empty />
      ) : (
        <ul className="space-y-0.5 text-xs">
          {d.refusal_reasons.map((r, i) => (
            <li key={r} title={r} className={i === 0 ? "font-medium text-red-700" : "text-gray-700"}>
              {refusalLabel(r)}
            </li>
          ))}
        </ul>
      ),
    className: "min-w-56",
  },
  {
    key: "enforced_by",
    label: "Enforced by",
    value: (d) => d.enforced_by,
    render: (d) => (d.enforced_by ? <span className="text-xs" title={enforcedByLabel(d) ?? undefined}>{d.enforced_by}</span> : <Empty />),
  },
  { key: "signers", label: "Signers", value: (d) => d.signers.join(" + "), className: "whitespace-nowrap text-xs" },
  { key: "checks", label: "Checks", value: (d) => d.checks.filter((c) => c.passed).length, render: (d) => <CheckDots checks={d.checks} />, title: "The co-signer's 8 checks in order; hover a dot for its detail" },
  { key: "ledger_result", label: "Ledger result", value: (d) => d.ledger_result, render: (d) => (d.ledger_result ? <ResultBadge result={d.ledger_result} /> : <Empty />) },
  { key: "tx", label: "XRPL tx", value: (d) => d.xrpl_tx_hash, render: (d) => <TxHash hash={d.xrpl_tx_hash} /> },
  { key: "hash", label: "Decision hash", value: (d) => d.decision_hash, render: (d) => <Mono title={d.decision_hash}>{d.decision_hash.slice(0, 10)}…</Mono> },
  { key: "rule_version", label: "Rules", value: (d) => d.rule_version, render: (d) => <Mono>{d.rule_version}</Mono> },
];

export function DecisionsTable({ decisions }: { decisions: Decision[] }) {
  return <DataTable id="decisions" label="decisions" rows={decisions} columns={DECISION_COLUMNS} rowKey={(d) => d.decision_id} initialSort={{ key: "created", dir: "desc" }} empty="The agent has made no payment decisions yet." />;
}

// ---------------------------------------------------------------------------
// Agencies
// ---------------------------------------------------------------------------

const AGENCY_COLUMNS: Column<AgencyStats>[] = [
  {
    key: "code",
    label: "Code",
    value: (a) => a.code,
    render: (a) => (
      <span className="flex items-center gap-1.5">
        <Mono>{a.code}</Mono>
        {a.is_demo_data && <DemoBadge />}
      </span>
    ),
  },
  { key: "name", label: "Agency", value: (a) => a.name, className: "min-w-56 font-medium text-gray-900" },
  { key: "late_pct", label: "Registered late", value: (a) => a.pct_contracts_registered_late, render: (a) => pct(a.pct_contracts_registered_late) || <Empty />, title: "Share of human-service contracts registered after their start date", align: "right" },
  { key: "late_days", label: "Avg days late", value: (a) => a.avg_days_registered_late, align: "right" },
  { key: "fy", label: "Fiscal year", value: (a) => a.fiscal_year },
  { key: "source_text", label: "Source note", value: (a) => a.source, className: "min-w-56 text-xs text-gray-600" },
  { key: "source", label: "Source", value: (a) => a.source_url, render: (a) => <SourceLink url={a.source_url} source={a.source} /> },
];

export function AgenciesTable({ agencies }: { agencies: AgencyStats[] }) {
  return <DataTable id="agencies" label="agencies" rows={agencies} columns={AGENCY_COLUMNS} rowKey={(a) => a.code} empty="No agency stats loaded." />;
}

// ---------------------------------------------------------------------------
// On-chain (real XRPL Testnet)
// ---------------------------------------------------------------------------

function Party({ address, role }: { address: string | null; role: string | null }) {
  if (!address) return <Empty />;
  return (
    <span className="whitespace-nowrap">
      <AccountLink address={address} label={role ?? undefined} />
    </span>
  );
}

const ONCHAIN_COLUMNS: Column<LedgerTxRow>[] = [
  {
    key: "date",
    label: "Date",
    value: (t) => toTime(t.date),
    render: (t) => (
      <span className="whitespace-nowrap">
        {fmtTime(t.date)}
        {t.live && (
          <span className="ml-1.5">
            <Badge tone="green" title="Arrived over the live account subscription">
              new
            </Badge>
          </span>
        )}
      </span>
    ),
  },
  { key: "type", label: "Type", value: (t) => t.type, render: (t) => <span className="whitespace-nowrap font-medium text-gray-900">{t.type}</span> },
  { key: "result", label: "Result", value: (t) => t.result, render: (t) => <ResultBadge result={t.result} /> },
  { key: "from", label: "From", value: (t) => t.account_role ?? t.account, render: (t) => <Party address={t.account} role={t.account_role} /> },
  { key: "to", label: "To", value: (t) => t.destination_role ?? t.destination, render: (t) => <Party address={t.destination} role={t.destination_role} /> },
  { key: "amount", label: "Amount", value: (t) => num(t.amount), render: (t) => <Money amount={t.amount} currency={t.currency} />, align: "right" },
  { key: "source_tag", label: "SourceTag", value: (t) => t.source_tag, render: (t) => (t.source_tag !== null ? <Mono>{t.source_tag}</Mono> : <Empty />) },
  {
    key: "signers",
    label: "Signers",
    value: (t) => `${t.signer_count} ${t.signer_roles.join(" + ")}`,
    render: (t) => (
      <span className="whitespace-nowrap text-xs" title={t.signing === "multisig" ? "Multisigned (Signers[] on the tx)" : "Single signature by the sending account's own key"}>
        <span className="tabular-nums font-medium">{t.signer_count}</span> · {t.signing === "multisig" ? t.signer_roles.join(" + ") : "single key"}
      </span>
    ),
  },
  {
    key: "memo",
    label: "Memo",
    value: (t) => (t.memo ? `${t.memo.inv} ${t.memo.ctr} ${t.memo.ein} ${t.memo.rv}` : null),
    render: (t) =>
      t.memo ? (
        <span className="block min-w-48 text-xs" title={`dh (decision hash) ${t.memo.dh}`}>
          <Mono>{t.memo.inv}</Mono>
          <span className="block text-gray-500">
            {t.memo.ctr} · EIN {t.memo.ein} · {t.memo.rv}
          </span>
        </span>
      ) : (
        <Empty />
      ),
  },
  { key: "details", label: "What it did", value: (t) => t.details, className: "min-w-64 text-xs text-gray-700" },
  {
    key: "hash",
    label: "Tx",
    value: (t) => t.hash,
    render: (t) => (
      <ExtLink href={t.explorer_url} title={t.hash} mono>
        {t.hash.slice(0, 10)}…
      </ExtLink>
    ),
  },
];

export function OnChainTable({ txs }: { txs: LedgerTxRow[] }) {
  return (
    <DataTable
      id="onchain-testnet"
      label="on-chain transactions"
      rows={txs}
      columns={ONCHAIN_COLUMNS}
      rowKey={(t) => t.hash}
      csvOmit={["tx"]}
      rowClassName={(t) => (t.live ? "bg-green-50/60" : "")}
      empty="No transactions on this account yet."
    />
  );
}

// ---------------------------------------------------------------------------
// Accounts (real XRPL Testnet)
// ---------------------------------------------------------------------------

const ACCOUNT_COLUMNS: Column<AccountState>[] = [
  { key: "role", label: "Role", value: (a) => a.role, render: (a) => <Mono>{a.role}</Mono> },
  { key: "label", label: "What it is", value: (a) => a.label, className: "min-w-56 text-gray-800" },
  { key: "address", label: "Address", value: (a) => a.address, render: (a) => <AccountLink address={a.address} /> },
  {
    key: "status",
    label: "On ledger",
    value: (a) => a.status,
    render: (a) =>
      a.status === "ok" ? (
        <Badge tone="green">funded account</Badge>
      ) : a.status === "keypair" ? (
        <Badge title="Signer keys are unfunded keypairs: they only sign for agent_account through its signer list">keypair (not an account)</Badge>
      ) : a.status === "not_found" ? (
        <Badge tone="red">not found</Badge>
      ) : (
        <Badge tone="red" title={a.error ?? undefined}>
          error
        </Badge>
      ),
  },
  { key: "xrp", label: "XRP", value: (a) => num(a.xrp), render: (a) => (a.xrp !== null ? <Money amount={a.xrp} currency="XRP" /> : <Empty />), align: "right" },
  {
    key: "rlusd",
    label: "RLUSD",
    value: (a) => num(a.rlusd),
    render: (a) =>
      a.kind === "rlusd_issuer" ? <span className="text-xs text-gray-500">issuer</span> : a.rlusd !== null ? <Money amount={a.rlusd} currency="RLUSD" /> : a.status === "ok" ? <span className="text-xs text-gray-500">no trust line</span> : <Empty />,
    align: "right",
  },
  {
    key: "master",
    label: "Master key",
    value: (a) => (a.master_disabled === null ? null : a.master_disabled ? "disabled" : "enabled"),
    render: (a) => (a.master_disabled === null ? <Empty /> : a.master_disabled ? <Badge tone="green">disabled</Badge> : <span className="text-xs text-gray-600">enabled</span>),
  },
  {
    key: "signer_list",
    label: "Signer list",
    value: (a) => (a.signer_list ? `quorum ${a.signer_list.quorum}: ${a.signer_list.entries.map((e) => `${e.role ?? e.address} ${e.weight}`).join(", ")}` : null),
    className: "text-xs",
  },
  { key: "sequence", label: "Sequence", value: (a) => a.sequence, align: "right" },
];

export function AccountsTable({ accounts }: { accounts: AccountState[] }) {
  return <DataTable id="accounts-testnet" label="Testnet accounts" rows={accounts} columns={ACCOUNT_COLUMNS} rowKey={(a) => `${a.role}:${a.address}`} empty="The registry lists no accounts." />;
}
