// Assembles the fixture dataset. Everything here is DEMO data (is_demo_data: true where the type has it).
import type { AgencyStats, Decision, Nonprofit, Payment, Site, Subscriber } from "../../../shared/contracts";
import { memoHash, memoJson } from "../lib/hash";
import { dateNY, nowNY } from "../lib/time";
import { computeRisk, RISK_FIXTURE_COMPUTED_AT, type ReleaseInfo, type Risk, type RiskInputs } from "../risk";
import { AGENCIES } from "./agencies";
import { CHECKBOOK_PAYMENTS, CONTRACTS, CONTRACTS_BY_ID } from "./contracts";
import { FIXTURE_DECISIONS } from "./decisions";
import { NONPROFITS } from "./nonprofits";
import { SITE_SEEDS, type SiteSeed } from "./sites";
import { FIXTURE_SUBSCRIBERS } from "./subscribers";

export { AGENCIES, CHECKBOOK_PAYMENTS, CONTRACTS, CONTRACTS_BY_ID, NONPROFITS };

export const TESTNET_EXPLORER_TX = "https://testnet.xrpl.org/transactions/";

export function agencyByCode(code: string): AgencyStats | null {
  return AGENCIES.find((a) => a.code.toLowerCase() === code.toLowerCase()) ?? null;
}

export function nonprofitByEin(ein: string): Nonprofit | null {
  return NONPROFITS.find((n) => n.ein === ein) ?? null;
}

/** Every agent Decision is also recorded as a Payment (source "xrpl"), whatever its outcome. */
export function xrplPaymentFromDecision(d: Decision): Payment {
  return {
    payment_id: `xrpl_${d.decision_id}`,
    source: "xrpl",
    contract_id: d.contract_id,
    payee_ein: d.payee_ein,
    amount: d.amount,
    currency: d.currency,
    date: d.created_at,
    status: d.outcome,
    invoice_id: d.invoice_id,
    // Only a transaction that reached the ledger has a hash / explorer link / memo hash.
    ...(d.xrpl_tx_hash
      ? {
          xrpl_tx_hash: d.xrpl_tx_hash,
          explorer_url: `${TESTNET_EXPLORER_TX}${d.xrpl_tx_hash}`,
          memo_hash: memoHash(memoJson(d)),
        }
      : {}),
    is_demo_data: true,
  };
}

/** Released XRPL RLUSD for a contract (only demo sites count XRPL payments toward "paid"). */
export function releasedOnLedger(contractId: string, decisions: Decision[]): number {
  return decisions
    .filter((d) => d.outcome === "released" && d.contract_id === contractId)
    .reduce((s, d) => s + Number(d.amount), 0);
}

export function riskInputsFor(site: Pick<Site, "contract_ids" | "nonprofit_ein" | "agency_code">, decisions: Decision[]): RiskInputs {
  const contract = CONTRACTS_BY_ID.get(site.contract_ids[0]);
  if (!contract) throw new Error(`unknown primary contract ${site.contract_ids[0]}`);
  return {
    contract,
    paid: Number(contract.spent_to_date) + releasedOnLedger(contract.contract_id, decisions),
    nonprofit: nonprofitByEin(site.nonprofit_ein),
    agency: agencyByCode(site.agency_code),
  };
}

export function siteRisk(site: SiteSeed | Site, decisions: Decision[], computedAt: string, release?: ReleaseInfo): Risk {
  return computeRisk(riskInputsFor(site, decisions), computedAt, release);
}

/** The fixture RELEASE RULE (demo_risk only): a released XRPL payment drops the payment-pace points and leads the reasons
 *  with the payment. `decisions` must include the released decision (under the site's primary contract). */
export function demoReleaseRisk(site: SiteSeed | Site, decisions: Decision[], d: Decision, computedAt: string = nowNY()): Risk {
  const releasedOn = dateNY(new Date(d.created_at));
  const when = releasedOn === dateNY() ? "today" : `on ${releasedOn}`;
  return siteRisk(site, decisions, computedAt, { amount: Number(d.amount), invoice_id: d.invoice_id, when });
}

export interface FixtureState {
  sites: Site[];
  decisions: Decision[];
  subscribers: Subscriber[];
}

/** A fresh, deep-copied initial state (used at boot and by POST /dev/reset). */
export function initialFixtureState(): FixtureState {
  const decisions = structuredClone(FIXTURE_DECISIONS);
  const sites: Site[] = SITE_SEEDS.map((seed) => {
    const { is_demo_data, ...rest } = structuredClone(seed);
    // Keep the field order of the Site interface (risk before is_demo_data) for readable JSON.
    return { ...rest, risk: siteRisk(seed, decisions, RISK_FIXTURE_COMPUTED_AT), is_demo_data };
  });
  return { sites, decisions, subscribers: structuredClone(FIXTURE_SUBSCRIBERS) };
}
