// Small cell renderers shared by the open-data tables (/data).
import type { ReactNode } from "react";
import type { Check, Decision, RiskLevel } from "@/lib/contracts";
import { OUTCOME_BADGES } from "@/lib/format";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/ledger";
import { formatAmount, isFakeTxHash } from "@/lib/openData";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";

export const Empty = () => <span className="text-gray-300">—</span>;

/** External link that does not toggle the row it sits in. */
export function ExtLink({ href, children, title, mono = false }: { href: string; children: ReactNode; title?: string; mono?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      onClick={(e) => e.stopPropagation()}
      className={`text-blue-700 underline decoration-blue-300 hover:decoration-blue-700 ${mono ? "font-mono" : ""}`}
    >
      {children}
    </a>
  );
}

export function Badge({ children, tone = "gray", title }: { children: ReactNode; tone?: "gray" | "amber" | "green" | "red" | "blue"; title?: string }) {
  const tones = {
    gray: "bg-gray-100 text-gray-700",
    amber: "bg-amber-100 text-amber-800",
    green: "bg-green-100 text-green-800",
    red: "bg-red-100 text-red-800",
    blue: "bg-blue-100 text-blue-800",
  };
  return (
    <span title={title} className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export const DemoBadge = ({ title = "is_demo_data: true (fictional fixture or seeded record)" }: { title?: string }) => (
  <Badge tone="amber" title={title}>
    demo
  </Badge>
);

export function SourceLink({ url, source }: { url?: string | null; source?: string | null }) {
  if (!url) return source ? <span className="text-xs text-gray-500">{source}</span> : <Empty />;
  return (
    <ExtLink href={url} title={source ?? url}>
      source
    </ExtLink>
  );
}

/** Real hashes link to the Testnet explorer; fixture placeholders (00000000FA15E...) are labelled fake with no link. */
export function TxHash({ hash }: { hash: string | null | undefined }) {
  if (!hash) return <Empty />;
  if (isFakeTxHash(hash)) {
    return (
      <span className="whitespace-nowrap text-xs text-gray-500" title={`${hash}: a fixture placeholder that exists on no ledger`}>
        fake (fixture)
      </span>
    );
  }
  return (
    <ExtLink href={explorerTxUrl(hash)} title={hash} mono>
      {hash.slice(0, 10)}…
    </ExtLink>
  );
}

export function AccountLink({ address, label }: { address: string; label?: string }) {
  return (
    <ExtLink href={explorerAccountUrl(address)} title={address} mono={!label}>
      {label ?? `${address.slice(0, 8)}…${address.slice(-4)}`}
    </ExtLink>
  );
}

export function Money({ amount, currency }: { amount: string | null | undefined; currency: string | null | undefined }) {
  const text = formatAmount(amount, currency);
  return text ? <span className="whitespace-nowrap tabular-nums">{text}</span> : <Empty />;
}

export function OutcomeBadge({ outcome }: { outcome: Decision["outcome"] }) {
  const b = OUTCOME_BADGES[outcome] ?? { label: outcome, className: "bg-gray-100 text-gray-700" };
  return <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${b.className}`}>{b.label}</span>;
}

/** 8 pass/fail dots in CHECK_NAMES order; hover one for the check's name and detail. */
export function CheckDots({ checks }: { checks: Check[] }) {
  const passed = checks.filter((c) => c.passed).length;
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={`${passed} of ${checks.length} checks passed`}>
      <span className="inline-flex gap-0.5">
        {checks.map((c) => (
          <span
            key={c.name}
            title={`${c.passed ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`}
            className={`h-2.5 w-2.5 rounded-full ${c.passed ? "bg-green-600" : "bg-red-600"}`}
          />
        ))}
      </span>
      <span className="text-[11px] tabular-nums text-gray-500">
        {passed}/{checks.length}
      </span>
    </span>
  );
}

export function RiskCell({ level, score }: { level: RiskLevel; score: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={RISK_LABELS[level]}>
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: RISK_COLORS[level] }} />
      <span className="tabular-nums">{score}</span>
      <span className="text-xs text-gray-500">{level}</span>
    </span>
  );
}

export function ResultBadge({ result }: { result: string }) {
  const tone = result === "tesSUCCESS" ? "green" : result.startsWith("tec") || result.startsWith("tef") || result.startsWith("tem") ? "red" : "gray";
  return (
    <Badge tone={tone} title={result}>
      {result}
    </Badge>
  );
}

export const Mono = ({ children, title }: { children: ReactNode; title?: string }) => (
  <span className="font-mono text-xs" title={title}>
    {children}
  </span>
);
