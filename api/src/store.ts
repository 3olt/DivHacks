// Data access behind one interface: FixtureStore (in-memory demo data, API_MODE=fixtures) and MongoStore
// (./mongoStore.ts, the Phase 4 collections in MongoDB Atlas, API_MODE=mongo). All methods are async. Returned objects are copies.
import type { AgencyStats, Decision, Site, SiteType, Subscriber, Trail } from "../../shared/contracts";
import {
  agencyByCode,
  CHECKBOOK_PAYMENTS,
  CONTRACTS_BY_ID,
  demoReleaseRisk,
  initialFixtureState,
  nonprofitByEin,
  xrplPaymentFromDecision,
  type FixtureState,
} from "./fixtures/index";
import { haversineMeters } from "./lib/geo";
import { nowNY, toMillis } from "./lib/time";
import type { Risk } from "./risk";

export type StoreMode = "fixtures" | "mongo";

export interface SiteQuery {
  types?: SiteType[];
  /** [minLng, minLat, maxLng, maxLat] */
  bbox?: [number, number, number, number];
  /** When set: only sites within radius_m, sorted nearest first. */
  near?: { lng: number; lat: number; radius_m: number };
}

export interface SubscriberInput {
  phone: string; // already E.164
  zip: string;
  interests?: string[];
  site_ids?: string[];
  channel?: Subscriber["channel"];
}

/** WS demo_risk_updated payload (minus type). previous_demo_risk = the demo view before (old demo_risk ?? risk). */
export interface DemoRiskUpdate {
  site_id: string;
  demo_risk: Risk | null;
  previous_demo_risk: Risk | null;
}

/** applyRelease: the demo_risk update to broadcast, or null with why (retry = a failed recompute a repeat event may retry). */
export type ReleaseResult = { update: DemoRiskUpdate } | { update: null; note: string; retry: boolean };

/** reset: sites whose PUBLIC risk changed (site_updated; normally none) and the demo_risk values cleared (demo_risk_updated). */
export interface ResetResult {
  risk_changed: string[];
  demo_cleared: DemoRiskUpdate[];
}

export interface DataStore {
  readonly mode: StoreMode;
  listSites(q: SiteQuery): Promise<Site[]>;
  getSite(id: string): Promise<Site | null>;
  /** Returns the ids from `ids` that do NOT exist. */
  missingSiteIds(ids: string[]): Promise<string[]>;
  getTrail(siteId: string): Promise<Trail | null>;
  getAgencyStats(code: string): Promise<AgencyStats | null>;
  /** Newest first. */
  listDecisions(limit: number): Promise<Decision[]>;
  getDecision(id: string): Promise<Decision | null>;
  /** Insert or replace by decision_id. */
  upsertDecision(d: Decision): Promise<void>;
  /** The site a decision belongs to: by contract_id in site.contract_ids, else by payee_ein. */
  findSiteForDecision(d: Decision): Promise<Site | null>;
  /** A released XRPL Testnet payment landed: recompute the site's DEMO score (sites.demo_risk), save and return it.
   *  NEVER changes the public `risk` (Sun 04:50: risk = public records only). */
  applyRelease(siteId: string, d: Decision): Promise<ReleaseResult>;
  setSiteRisk(siteId: string, risk: Risk): Promise<Site | null>;
  listSubscribers(siteId?: string): Promise<Subscriber[]>;
  getSubscriber(phone: string): Promise<Subscriber | null>;
  /** Upsert by phone. On update: zip replaced, channel replaced when given, interests and site_ids merged (union). */
  upsertSubscriber(input: SubscriberInput): Promise<{ subscriber: Subscriber; created: boolean }>;
  deleteSubscriber(phone: string): Promise<boolean>;
  /** Monotonic counter for synthesized demo ids (fixture mode). */
  nextDemoSeq(): Promise<number>;
  /** Restore the initial state: clears every demo_risk (new demo epoch). Public risk normally does not change. */
  reset(): Promise<ResetResult>;
  /** Release connections (mongo mode). */
  close?(): Promise<void>;
}

const clone = <T>(v: T): T => structuredClone(v);
/**
 * Newest first by created_at. Timestamps have 1 s resolution, so decisions made in the same second (e.g. two
 * demo clicks) tie; the one inserted later is newer. `ds` must be in insertion order (state.decisions is).
 */
const newestFirst = (ds: Decision[]): Decision[] =>
  ds
    .map((d, i) => ({ d, i }))
    .sort((a, b) => toMillis(b.d.created_at) - toMillis(a.d.created_at) || b.i - a.i)
    .map((x) => x.d);
const union = (a: string[], b: string[] = []) => [...new Set([...a, ...b])];

export class FixtureStore implements DataStore {
  readonly mode = "fixtures" as const;
  private state: FixtureState = initialFixtureState();
  private demoSeq = 0;

  async listSites(q: SiteQuery): Promise<Site[]> {
    let rows = this.state.sites;
    if (q.types?.length) rows = rows.filter((s) => q.types!.includes(s.type));
    if (q.bbox) {
      const [minLng, minLat, maxLng, maxLat] = q.bbox;
      rows = rows.filter(({ location: { coordinates: [lng, lat] } }) => lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat);
    }
    if (q.near) {
      const { lng, lat, radius_m } = q.near;
      rows = rows
        .map((s) => ({ s, d: haversineMeters([lng, lat], s.location.coordinates) }))
        .filter((x) => x.d <= radius_m)
        .sort((a, b) => a.d - b.d)
        .map((x) => x.s);
    }
    return clone(rows);
  }

  async getSite(id: string): Promise<Site | null> {
    const s = this.state.sites.find((x) => x.id === id);
    return s ? clone(s) : null;
  }

  async missingSiteIds(ids: string[]): Promise<string[]> {
    const known = new Set(this.state.sites.map((s) => s.id));
    return ids.filter((id) => !known.has(id));
  }

  async getTrail(siteId: string): Promise<Trail | null> {
    const site = this.state.sites.find((s) => s.id === siteId);
    if (!site) return null;
    const agency = agencyByCode(site.agency_code);
    const nonprofit = nonprofitByEin(site.nonprofit_ein);
    if (!agency || !nonprofit) throw new Error(`fixture site ${siteId} is missing its agency or nonprofit`);
    const ids = new Set(site.contract_ids);
    const decisions = this.state.decisions.filter((d) => ids.has(d.contract_id));
    const payments = [
      ...CHECKBOOK_PAYMENTS.filter((p) => ids.has(p.contract_id)),
      ...decisions.map(xrplPaymentFromDecision),
    ].sort((a, b) => toMillis(a.date) - toMillis(b.date));
    return clone({
      site_id: site.id,
      agency,
      contracts: site.contract_ids.map((id) => CONTRACTS_BY_ID.get(id)!).filter(Boolean),
      payments,
      nonprofit,
      decisions: newestFirst(decisions),
    });
  }

  async getAgencyStats(code: string): Promise<AgencyStats | null> {
    const a = agencyByCode(code);
    return a ? clone(a) : null;
  }

  async listDecisions(limit: number): Promise<Decision[]> {
    return clone(newestFirst(this.state.decisions).slice(0, limit));
  }

  async getDecision(id: string): Promise<Decision | null> {
    const d = this.state.decisions.find((x) => x.decision_id === id);
    return d ? clone(d) : null;
  }

  async upsertDecision(d: Decision): Promise<void> {
    const i = this.state.decisions.findIndex((x) => x.decision_id === d.decision_id);
    if (i >= 0) this.state.decisions[i] = clone(d);
    else this.state.decisions.push(clone(d));
  }

  async findSiteForDecision(d: Decision): Promise<Site | null> {
    const s =
      this.state.sites.find((x) => x.contract_ids.includes(d.contract_id)) ??
      this.state.sites.find((x) => x.nonprofit_ein === d.payee_ein);
    return s ? clone(s) : null;
  }

  /** Same contract as mongo mode: the fixture release rule goes to demo_risk; the public risk is never changed. */
  async applyRelease(siteId: string, d: Decision): Promise<ReleaseResult> {
    const site = this.state.sites.find((s) => s.id === siteId);
    if (!site) return { update: null, note: `no site ${siteId}`, retry: false };
    const previous = clone(site.demo_risk ?? site.risk);
    site.demo_risk = demoReleaseRisk(site, this.state.decisions, d);
    return { update: { site_id: site.id, demo_risk: clone(site.demo_risk), previous_demo_risk: previous } };
  }

  async setSiteRisk(siteId: string, risk: Risk): Promise<Site | null> {
    const site = this.state.sites.find((s) => s.id === siteId);
    if (!site) return null;
    site.risk = clone(risk);
    return clone(site);
  }

  async listSubscribers(siteId?: string): Promise<Subscriber[]> {
    const rows = siteId ? this.state.subscribers.filter((s) => s.site_ids.includes(siteId)) : this.state.subscribers;
    return clone(rows);
  }

  async getSubscriber(phone: string): Promise<Subscriber | null> {
    const s = this.state.subscribers.find((x) => x.phone === phone);
    return s ? clone(s) : null;
  }

  async upsertSubscriber(input: SubscriberInput): Promise<{ subscriber: Subscriber; created: boolean }> {
    const existing = this.state.subscribers.find((s) => s.phone === input.phone);
    if (existing) {
      existing.zip = input.zip;
      existing.interests = union(existing.interests, input.interests);
      existing.site_ids = union(existing.site_ids, input.site_ids);
      if (input.channel) existing.channel = input.channel;
      return { subscriber: clone(existing), created: false };
    }
    const sub: Subscriber = {
      phone: input.phone,
      zip: input.zip,
      interests: union([], input.interests),
      site_ids: union([], input.site_ids),
      opted_in_at: nowNY(),
      channel: input.channel ?? "web",
    };
    this.state.subscribers.push(sub);
    return { subscriber: clone(sub), created: true };
  }

  async deleteSubscriber(phone: string): Promise<boolean> {
    const i = this.state.subscribers.findIndex((s) => s.phone === phone);
    if (i < 0) return false;
    this.state.subscribers.splice(i, 1);
    return true;
  }

  async nextDemoSeq(): Promise<number> {
    return ++this.demoSeq;
  }

  async reset(): Promise<ResetResult> {
    const before = new Map(this.state.sites.map((s) => [s.id, JSON.stringify(s.risk)]));
    const demo_cleared: DemoRiskUpdate[] = this.state.sites
      .filter((s) => s.demo_risk)
      .map((s) => ({ site_id: s.id, demo_risk: null, previous_demo_risk: clone(s.demo_risk!) }));
    this.state = initialFixtureState();
    this.demoSeq = 0;
    return { risk_changed: this.state.sites.filter((s) => before.get(s.id) !== JSON.stringify(s.risk)).map((s) => s.id), demo_cleared };
  }
}
