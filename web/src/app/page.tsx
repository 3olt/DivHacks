import Link from "next/link";
import { RISK_COLORS } from "@/lib/risk";

// Landing page: project overview with a launch button to the live map (/map).
// "NYC Money Map" is a working name until the team picks one.

const COMPTROLLER_REPORT = "https://comptroller.nyc.gov/reports/nonprofit-nonpayment";

const STATS = [
  { value: "$1B+", label: "owed to nonprofits in unpaid city invoices", source: "NYC Comptroller, 2025" },
  { value: "7,000+", label: "unpaid invoices from human-service providers", source: "NYC Comptroller, 2025" },
  { value: "~90%", label: "of human-service contracts registered late (FY2024)", source: "NYC Comptroller" },
];

const STEPS = [
  {
    title: "See where services are at risk",
    body: "Every food pantry, shelter, and youth program is a pin, colored by how late the city money behind it is. The score is explainable: each pin lists the numbers that drive it.",
  },
  {
    title: "Follow the money",
    body: "Click a pin to trace it: city agency → contract → payments → nonprofit, with links to the public records behind each step (Checkbook NYC, the Comptroller, IRS 990 filings).",
  },
  {
    title: "Watch payments happen, and get blocked",
    body: "An AI agent pays verified invoices on the XRP Ledger. Every attempt is public: paid, blocked, or waiting for approval, with the reason, who signed, and an audit fingerprint.",
  },
  {
    title: "Get alerts you qualify for",
    body: "Sign up with your phone to get iMessage alerts about free food and events near you, and when their funding is running late.",
  },
];

const GUARDRAILS = [
  "The agent's key is only 1 of 3 signature weights. The XRP Ledger itself rejects a payment the agent signs alone.",
  "An independent compliance co-signer re-checks every payment: verified wallet, no duplicates, within the contract and daily limits.",
  "Wallets are tied to each nonprofit with an on-ledger credential, so money can't be redirected to a look-alike account.",
  "Large payments wait for a human officer. A kill switch can revoke the agent's key.",
];

export default function Landing() {
  return (
    <div className="min-h-dvh bg-white text-gray-900">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <span className="flex items-center gap-2 font-semibold">
          <PinDots />
          NYC Money Map
        </span>
        <LaunchButton small />
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-10 sm:px-6 md:grid-cols-2 md:pt-16">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">Transparency for NYC&apos;s community services</p>
            <h1 className="mt-3 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">See where the city&apos;s money is stuck, and where it goes.</h1>
            <p className="mt-4 text-lg text-gray-600">
              A live map of food pantries, shelters, and youth programs, colored by whether the city money behind them is on time. Every step of the money is traceable, down to the payment on the XRP Ledger.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LaunchButton />
              <a href="#how" className="rounded-lg border border-gray-300 px-5 py-3 font-medium text-gray-800 hover:border-gray-900">
                How it works
              </a>
            </div>
          </div>
          <PreviewCard />
        </section>

        {/* Problem */}
        <section className="border-y border-gray-200 bg-gray-50">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 className="text-2xl font-bold">The problem</h2>
            <p className="mt-2 max-w-3xl text-gray-600">
              NYC relies on nonprofits to feed people, shelter families, and run youth programs, and pays them late. Providers take on debt and cut services. The people who depend on those services can&apos;t see any of it.
            </p>
            <dl className="mt-8 grid gap-4 sm:grid-cols-3">
              {STATS.map((s) => (
                <div key={s.value} className="rounded-xl border border-gray-200 bg-white p-5">
                  <dt className="text-3xl font-bold">{s.value}</dt>
                  <dd className="mt-1 text-sm text-gray-700">{s.label}</dd>
                  <dd className="mt-2 text-xs text-gray-500">
                    <a href={COMPTROLLER_REPORT} target="_blank" rel="noreferrer" className="underline">
                      {s.source}
                    </a>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="mx-auto max-w-6xl scroll-mt-4 px-4 py-14 sm:px-6">
          <h2 className="text-2xl font-bold">How it works</h2>
          <ol className="mt-8 grid gap-6 sm:grid-cols-2">
            {STEPS.map((step, i) => (
              <li key={step.title} className="rounded-xl border border-gray-200 p-5">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-900 text-sm font-semibold text-white">{i + 1}</span>
                <h3 className="mt-3 font-semibold">{step.title}</h3>
                <p className="mt-1 text-sm text-gray-600">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Guardrails */}
        <section className="bg-gray-900 text-white">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 className="text-2xl font-bold">An AI agent that moves money, with limits it can&apos;t talk its way out of</h2>
            <p className="mt-2 max-w-3xl text-gray-300">
              The agent pays verified invoices on its own, in RLUSD on the XRP Ledger. The guardrails are enforced outside the agent, by a separate co-signer and by the ledger.
            </p>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2">
              {GUARDRAILS.map((g) => (
                <li key={g} className="flex gap-3 rounded-xl border border-gray-700 p-4 text-sm text-gray-200">
                  <span className="mt-0.5 text-green-400">✓</span>
                  {g}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Honesty + CTA */}
        <section className="mx-auto max-w-6xl px-4 py-14 text-center sm:px-6">
          <h2 className="text-2xl font-bold">See it live</h2>
          <p className="mx-auto mt-2 max-w-2xl text-gray-600">Open the map, click a pin, and follow the money. Run a payment from the demo controls and watch the pin change color.</p>
          <div className="mt-6 flex justify-center">
            <LaunchButton />
          </div>
          <p className="mx-auto mt-8 max-w-2xl text-xs text-gray-500">
            Built at DivHacks 2026. The map currently shows demo data: fictional organizations placed at real NYC addresses, and payments on the XRP Ledger Testnet (no real money). Public-record sources are linked wherever they&apos;re used.
          </p>
        </section>
      </main>
    </div>
  );
}

function LaunchButton({ small = false }: { small?: boolean }) {
  return (
    <Link
      href="/map"
      className={`rounded-lg bg-gray-900 font-medium text-white hover:bg-gray-700 ${small ? "px-4 py-2 text-sm" : "px-5 py-3"}`}
    >
      Launch the map →
    </Link>
  );
}

function PinDots() {
  return (
    <span className="flex gap-0.5" aria-hidden>
      {(["green", "yellow", "red"] as const).map((l) => (
        <span key={l} className="h-2.5 w-2.5 rounded-full" style={{ background: RISK_COLORS[l] }} />
      ))}
    </span>
  );
}

// Static illustration of a pin's summary, built from the demo data's golden site.
function PreviewCard() {
  const rows = [
    { level: "yellow" as const, name: "Burnside Heights Community Pantry", note: "41% of contract term elapsed, 15% paid" },
    { level: "green" as const, name: "Fordham Youth Robotics Lab", note: "5.2 months of cash on hand (FY2024 990)" },
    { level: "red" as const, name: "Mott Haven Saturday Grocery Giveaway", note: "24% of contract term elapsed, 0% paid" },
  ];
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-lg" aria-label="Example of what the map shows">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Example · demo data</p>
      <ul className="mt-3 space-y-3">
        {rows.map((r) => (
          <li key={r.name} className="flex items-start gap-3 rounded-lg border border-gray-100 p-3">
            <span className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-white shadow" style={{ background: RISK_COLORS[r.level] }} />
            <div>
              <p className="text-sm font-medium">{r.name}</p>
              <p className="text-xs text-gray-600">{r.note}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-4 rounded-lg bg-green-50 p-3 text-xs text-green-900">
        <span className="font-semibold">Paid</span> · 1,250.00 RLUSD to Burnside Heights Food Collective · signed by agent + co-signer · audit hash 5d0a6879…
      </div>
    </div>
  );
}
