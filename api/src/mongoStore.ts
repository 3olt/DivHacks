// MongoStore: the DataStore interface over the Phase 4 collections in MongoDB Atlas (db MONGODB_DB or "divhacks").
//   sites          15 real sites (data/ingest.py, risk by data/risk.py) + 4 demo sites (npm run seed:demo-sites -w api)
//   contracts      real contracts (spent_to_date may be null = not loaded) + the demo contracts (xrpl seed-registry)
//   payments       real Checkbook checks (source "checkbook", USD) + every agent attempt (source "xrpl", written by xrpl/)
//   nonprofits     15 real orgs + np_1..np_4 demo orgs; `wallet` written by xrpl/ (seed-registry, onboarding)
//   agency_stats   Comptroller-derived registration lateness per agency (key `code`)
//   decisions      every agent Decision (written by xrpl/, + `audit` which the API never serves)
//   demo_state     {_id:"golden"}: golden site/contract ids + Option B demo scale (data/)
//   subscribers    the API's own collection (phone unique)
// Responses keep the docs/API.md shapes: `_id` is stripped everywhere and a decision's `audit` subdocument is never served.
// Additive extras that the documents carry (risk.components, contract end_date_loaded / end_date_assumed / end_date_note,
// source notes, ...) are passed through; clients ignore fields they don't know.
// Two response views keep the honesty rules for clients that only read the core fields: a contract whose end_date is a
// disclosed demo assumption (the golden) is served with its REAL end in `end_date` (+ `end_date_demo_assumed`), and a real
// site's seeded events carry " (demo event)" in the title (serveContract / serveSite).
// Writes: sites.risk (PUBLIC RECORDS ONLY: data/risk.py, or the dev flip; never from an XRPL Testnet payment),
// sites.demo_risk (the /demo what-if: data/risk.py --demo-risk for the golden, the fixture release rule for the demo sites;
// $unset by POST /dev/reset and data/demo_reset.py), subscribers. Decisions are never written
// here: the agent's Mongo record is authoritative.
import { MongoClient, type Collection, type Db, type Document, type Filter } from "mongodb";
import type { AgencyStats, Decision, Nonprofit, Payment, Site, Subscriber, Trail } from "../../shared/contracts";
import { DEMO_SITE_IDS, demoSiteDocs } from "./demoSites";
import { demoReleaseRisk } from "./fixtures/index";
import { FIXTURE_DECISIONS } from "./fixtures/decisions";
import { SITE_SEEDS } from "./fixtures/sites";
import { lastJsonLine, runDataScript, scrub } from "./lib/python";
import { nowNY, toMillis } from "./lib/time";
import type { Risk } from "./risk";
import type { DataStore, ReleaseResult, ResetResult, SiteQuery, SubscriberInput } from "./store";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
const consoleLogger: Logger = { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) };

const NO_ID = { _id: 0 } as const;
/** Decisions: _id dropped; the agent's `audit` subdocument is never served. The one audit field lifted out is
 *  `approved_from` (additive, public): an officer-approved over-limit execution names the pending decision it executed,
 *  whose decision_hash its on-ledger memo carries. */
const SERVE_DECISION: Document[] = [
  { $addFields: { approved_from: { $cond: [{ $eq: [{ $type: "$audit.approved_from" }, "string"] }, "$audit.approved_from", "$$REMOVE"] } } },
  { $project: { _id: 0, audit: 0 } },
];
const NEWEST_FIRST = { $sort: { created_at: -1, _id: -1 } };
const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];

/** Public nonprofit fields served in a trail (whitelist: never onboarding internals). */
const NONPROFIT_FIELDS = ["ein", "name", "address", "service_types", "financials", "wallet", "is_demo_data", "source", "source_url", "ntee_code", "address_note"] as const;
const WALLET_FIELDS = ["address", "credential_status", "credential_expires", "bank_verified", "label", "is_demo_data"] as const;

/** Served on real sites only: every SEEDED event (is_demo_data true) on a REAL organization's site gets this title suffix,
 *  so a made-up schedule is never read as the organization's own (the website's popup and report show the title only). */
export const DEMO_EVENT_SUFFIX = " (demo event)";

/** Response view of a site document: real sites' seeded events are labelled in the title (see DEMO_EVENT_SUFFIX). */
export function serveSite<T>(doc: T): T {
  const s = doc as unknown as { is_demo_data?: boolean; events?: { title?: unknown; is_demo_data?: boolean }[] } | null;
  if (!s || s.is_demo_data !== false || !Array.isArray(s.events)) return doc;
  return {
    ...s,
    events: s.events.map((e) =>
      e && e.is_demo_data === true && typeof e.title === "string" && !e.title.endsWith(DEMO_EVENT_SUFFIX) ? { ...e, title: `${e.title}${DEMO_EVENT_SUFFIX}` } : e,
    ),
  } as unknown as T;
}

/** Response view of a contract: when `end_date_assumed` is set (only the golden contract), `end_date` is served as the REAL
 *  end from the public record (`end_date_loaded`) and the disclosed demo assumption moves to `end_date_demo_assumed`.
 *  The co-signer reads Mongo directly (xrpl/src/lib/contractPins.ts), so its active-term check is unchanged. */
export function serveContract<T>(doc: T): T {
  const c = doc as unknown as { end_date?: unknown; end_date_assumed?: unknown; end_date_loaded?: unknown };
  if (c?.end_date_assumed !== true || typeof c.end_date_loaded !== "string" || c.end_date === c.end_date_loaded) return doc;
  return { ...c, end_date: c.end_date_loaded, end_date_demo_assumed: c.end_date } as unknown as T;
}

function pick<T extends string>(o: Record<string, unknown>, keys: readonly T[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export interface MongoStoreOptions {
  uri: string;
  dbName?: string;
  logger?: Logger;
  /** Connect / server-selection timeout. */
  timeoutMs?: number;
}

export class MongoStore implements DataStore {
  readonly mode = "mongo" as const;
  private demoSeq = 0;
  /** Sites whose risk was changed by POST /dev/flip (DEV_ROUTES=1); POST /dev/reset re-scores them. */
  private readonly flipped = new Set<string>();
  /** Serializes risk recomputes per process (risk.py writes sites.risk; two at once would race). */
  private riskQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly client: MongoClient,
    readonly db: Db,
    private readonly log: Logger,
  ) {}

  /** Connects and pings (fails within timeoutMs if Atlas is unreachable). The URI is never logged. */
  static async connect(opts: MongoStoreOptions): Promise<MongoStore> {
    const timeout = opts.timeoutMs ?? 8000;
    const client = new MongoClient(opts.uri, { appName: "divhacks-api", serverSelectionTimeoutMS: timeout, connectTimeoutMS: timeout });
    try {
      await client.connect();
      const db = client.db(opts.dbName ?? "divhacks");
      await db.command({ ping: 1 });
      const store = new MongoStore(client, db, opts.logger ?? consoleLogger);
      await store.ensureIndexes();
      return store;
    } catch (e) {
      await client.close().catch(() => undefined);
      throw new Error(scrub((e as Error).message));
    }
  }

  private get sites(): Collection<Document> {
    return this.db.collection("sites");
  }
  private get subscribers(): Collection<Document> {
    return this.db.collection("subscribers");
  }

  private async ensureIndexes(): Promise<void> {
    await this.subscribers.createIndex({ phone: 1 }, { unique: true, name: "phone_unique" });
    await this.subscribers.createIndex({ site_ids: 1 }, { name: "site_ids" });
  }

  /** Startup self-check: counts that tell the operator whether ingest / seeding ran. */
  async describe(): Promise<{ real_sites: number; demo_sites: number; missing_demo_sites: string[]; decisions: number; golden_site: string | null }> {
    const [real, demo, decisions, golden] = await Promise.all([
      this.sites.countDocuments({ is_demo_data: false }),
      this.sites.find({ id: { $in: DEMO_SITE_IDS } }, { projection: { id: 1 } }).toArray(),
      this.db.collection("decisions").estimatedDocumentCount(),
      this.demoState(),
    ]);
    const have = new Set(demo.map((d) => d.id as string));
    return { real_sites: real, demo_sites: have.size, missing_demo_sites: DEMO_SITE_IDS.filter((id) => !have.has(id)), decisions, golden_site: golden?.golden_site_id ?? null };
  }

  private async demoState(): Promise<{ golden_site_id?: string; golden_contract_id?: string } | null> {
    return (await this.db.collection("demo_state").findOne({ _id: "golden" as never }, { projection: { golden_site_id: 1, golden_contract_id: 1 } })) as {
      golden_site_id?: string;
      golden_contract_id?: string;
    } | null;
  }

  // ------------------------------------------------------------------------------------------------ sites

  async listSites(q: SiteQuery): Promise<Site[]> {
    const filter: Filter<Document> = {};
    if (q.types?.length) filter.type = { $in: q.types };
    const bbox = q.bbox ? { $geoWithin: { $box: [[q.bbox[0], q.bbox[1]], [q.bbox[2], q.bbox[3]]] } } : null;
    if (q.near) {
      // $geoNear (2dsphere index location_2dsphere): only sites within radius_m, nearest first.
      const query: Filter<Document> = { ...filter };
      if (bbox) query.location = bbox;
      const rows = await this.sites
        .aggregate([
          {
            $geoNear: {
              near: { type: "Point", coordinates: [q.near.lng, q.near.lat] },
              distanceField: "_distance_m",
              maxDistance: q.near.radius_m,
              spherical: true,
              key: "location",
              query,
            },
          },
          { $project: { _id: 0, _distance_m: 0 } },
        ])
        .toArray();
      return rows.map(serveSite) as unknown as Site[];
    }
    if (bbox) filter.location = bbox;
    return (await this.sites.find(filter, { projection: NO_ID }).sort({ id: 1 }).toArray()).map(serveSite) as unknown as Site[];
  }

  async getSite(id: string): Promise<Site | null> {
    return serveSite((await this.sites.findOne({ id }, { projection: NO_ID })) as unknown as Site | null);
  }

  async missingSiteIds(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const found = await this.sites.find({ id: { $in: ids } }, { projection: { _id: 0, id: 1 } }).toArray();
    const known = new Set(found.map((d) => d.id as string));
    return ids.filter((id) => !known.has(id));
  }

  async getTrail(siteId: string): Promise<Trail | null> {
    const site = await this.getSite(siteId);
    if (!site) return null;
    const demo = await this.demoState();
    const contractIds = [...site.contract_ids];
    // The golden site's decisions/payments always include the golden contract (demo_state), even if contract_ids changes.
    if (demo?.golden_site_id === site.id && demo.golden_contract_id && !contractIds.includes(demo.golden_contract_id)) contractIds.push(demo.golden_contract_id);

    const [agency, contractDocs, payments, nonprofitDoc, decisions] = await Promise.all([
      this.getAgencyStats(site.agency_code),
      this.db.collection("contracts").find({ contract_id: { $in: site.contract_ids } }, { projection: NO_ID }).toArray(),
      this.db.collection("payments").find({ contract_id: { $in: contractIds } }, { projection: NO_ID }).toArray(),
      this.db.collection("nonprofits").findOne({ ein: site.nonprofit_ein }, { projection: NO_ID }),
      this.db.collection("decisions").aggregate([{ $match: { contract_id: { $in: contractIds } } }, NEWEST_FIRST, ...SERVE_DECISION]).toArray(),
    ]);
    const byId = new Map(contractDocs.map((c) => [c.contract_id as string, c]));
    const contracts = site.contract_ids.map((id) => byId.get(id)).filter((c) => !!c).map(serveContract);
    const sortedPayments = payments
      .map((p, i) => ({ p, i }))
      .sort((a, b) => toMillis(a.p.date as string) - toMillis(b.p.date as string) || a.i - b.i)
      .map((x) => x.p);

    let nonprofit: Nonprofit;
    if (nonprofitDoc) {
      const np = pick(nonprofitDoc as Record<string, unknown>, NONPROFIT_FIELDS);
      if (np.wallet && typeof np.wallet === "object") np.wallet = pick(np.wallet as Record<string, unknown>, WALLET_FIELDS);
      nonprofit = np as unknown as Nonprofit;
    } else {
      nonprofit = { ein: site.nonprofit_ein, name: "(nonprofit record not loaded)", address: site.address ?? "", service_types: [site.type] };
    }
    return {
      site_id: site.id,
      agency: agency ?? {
        code: site.agency_code,
        name: site.agency_code,
        pct_contracts_registered_late: null,
        avg_days_registered_late: null,
        fiscal_year: null,
        source: "not loaded",
        source_url: "",
        is_demo_data: false,
      },
      contracts: contracts as unknown as Trail["contracts"],
      payments: sortedPayments as unknown as Payment[],
      nonprofit,
      decisions: decisions as unknown as Decision[],
    };
  }

  async getAgencyStats(code: string): Promise<AgencyStats | null> {
    const esc = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (await this.db.collection("agency_stats").findOne({ code: { $regex: `^${esc}$`, $options: "i" } }, { projection: NO_ID })) as unknown as AgencyStats | null;
  }

  // ------------------------------------------------------------------------------------------------ decisions

  async listDecisions(limit: number): Promise<Decision[]> {
    // created_at is ISO UTC ("...Z", 1 s resolution) on every agent record, so the string sort is chronological;
    // ties (same second) fall back to insertion order (_id), latest first.
    return (await this.db.collection("decisions").aggregate([NEWEST_FIRST, { $limit: limit }, ...SERVE_DECISION]).toArray()) as unknown as Decision[];
  }

  async getDecision(id: string): Promise<Decision | null> {
    const [d] = await this.db.collection("decisions").aggregate([{ $match: { decision_id: id } }, { $limit: 1 }, ...SERVE_DECISION]).toArray();
    return (d as unknown as Decision | undefined) ?? null;
  }

  async upsertDecision(_d: Decision): Promise<void> {
    // The agent process (xrpl/) is the only writer of decisions; the API never stores a pushed copy in mongo mode.
    throw new Error("mongo mode: decisions are written by the agent (xrpl/), not the API");
  }

  async findSiteForDecision(d: Decision): Promise<Site | null> {
    return serveSite(
      ((await this.sites.findOne({ contract_ids: d.contract_id }, { projection: NO_ID })) as unknown as Site | null) ??
        ((await this.sites.findOne({ nonprofit_ein: d.payee_ein }, { projection: NO_ID, sort: { is_demo_data: 1, id: 1 } })) as unknown as Site | null),
    );
  }

  /**
   * A released XRPL Testnet payment landed (Sun 04:50: risk vs demo_risk). The PUBLIC `risk` is never touched.
   * Golden site: data/risk.py --site <id> --demo-risk --json (Option B demo scale) writes sites.demo_risk.
   * Demo site (site_001..site_004): the fixture release rule (api/src/risk.ts, as in fixture mode) -> sites.demo_risk.
   * Any other real site: no demo effect (XRPL Testnet payments never score a real organization).
   * previous_demo_risk = the site's demo view before (its old demo_risk ?? its risk).
   */
  async applyRelease(siteId: string, d: Decision): Promise<ReleaseResult> {
    const site = await this.getSite(siteId);
    if (!site) return { update: null, note: `no site ${siteId}`, retry: false };
    const previous = site.demo_risk ?? site.risk;
    if (site.id === (await this.demoState())?.golden_site_id) {
      const demo = await this.recomputeRisk(siteId, `released ${d.decision_id}`, true);
      if (!demo) return { update: null, note: "demo_risk recompute failed: the previous demo_risk is kept (see the API log)", retry: true };
      return { update: { site_id: site.id, demo_risk: demo, previous_demo_risk: previous } };
    }
    if (site.is_demo_data) {
      const seed = SITE_SEEDS.find((s) => s.id === site.id);
      if (!seed) return { update: null, note: `demo site ${site.id} has no fixture seed: no demo_risk`, retry: false };
      // The fixture rule over the fixture seed; the Testnet decision is counted under the seed's primary contract.
      const decisions = [...FIXTURE_DECISIONS, { ...d, contract_id: seed.contract_ids[0] }];
      const demo: Risk = { ...demoReleaseRisk(seed, decisions, d), rule_version: "fixture-risk-0" };
      await this.sites.updateOne({ id: site.id }, { $set: { demo_risk: demo } });
      this.log.info(`released ${d.decision_id} on demo site ${siteId}: demo_risk ${previous.level} ${previous.score} -> ${demo.level} ${demo.score}`);
      return { update: { site_id: site.id, demo_risk: demo, previous_demo_risk: previous } };
    }
    return { update: null, note: "real site: XRPL Testnet payments never change its public-records risk and it has no demo score", retry: false };
  }

  /** Runs data/risk.py --site <id> [--demo-risk] --json (serialized); returns the stored risk (demo: demo_risk), or null
   *  (old value kept) on failure. */
  recomputeRisk(siteId: string, why: string, demo = false): Promise<Risk | null> {
    const run = async (): Promise<Risk | null> => {
      const r = await runDataScript("risk.py", ["--site", siteId, ...(demo ? ["--demo-risk"] : []), "--json"]);
      const printed = lastJsonLine(r.stdout);
      const cmd = `risk.py --site ${siteId}${demo ? " --demo-risk" : ""}`;
      if (r.code !== 0 || !printed || typeof printed.level !== "string" || typeof printed.score !== "number") {
        const tail = scrub(`${r.stderr}\n${r.stdout}`).trim().split(/\r?\n/).slice(-3).join(" | ");
        this.log.error(`${cmd} (${why}) failed: ${r.timedOut ? "timeout" : r.error ?? `exit ${r.code}`}; old value kept. ${tail}`);
        return null;
      }
      const stored = await this.getSite(siteId);
      const value = (demo ? stored?.demo_risk : stored?.risk) ?? null;
      this.log.info(`${cmd} (${why}): ${value?.level} ${value?.score} in ${r.ms} ms`);
      return value;
    };
    const p = this.riskQueue.then(run, run);
    this.riskQueue = p.catch(() => undefined);
    return p;
  }

  async setSiteRisk(siteId: string, risk: Risk): Promise<Site | null> {
    const res = await this.sites.findOneAndUpdate({ id: siteId }, { $set: { risk } }, { projection: NO_ID, returnDocument: "after" });
    if (res) this.flipped.add(siteId);
    return serveSite(res as unknown as Site | null);
  }

  // ------------------------------------------------------------------------------------------------ subscribers

  async listSubscribers(siteId?: string): Promise<Subscriber[]> {
    const filter = siteId ? { site_ids: siteId } : {};
    return (await this.subscribers.find(filter, { projection: NO_ID }).sort({ _id: 1 }).toArray()) as unknown as Subscriber[];
  }

  async getSubscriber(phone: string): Promise<Subscriber | null> {
    return (await this.subscribers.findOne({ phone }, { projection: NO_ID })) as unknown as Subscriber | null;
  }

  /** Same semantics as FixtureStore: upsert by phone; on update zip replaced, channel replaced when given,
   *  interests and site_ids merged (union). */
  async upsertSubscriber(input: SubscriberInput): Promise<{ subscriber: Subscriber; created: boolean }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.getSubscriber(input.phone);
      if (existing) {
        const next: Subscriber = {
          ...existing,
          zip: input.zip,
          interests: union(existing.interests, input.interests),
          site_ids: union(existing.site_ids, input.site_ids),
          channel: input.channel ?? existing.channel,
        };
        await this.subscribers.updateOne({ phone: input.phone }, { $set: { zip: next.zip, interests: next.interests, site_ids: next.site_ids, channel: next.channel } });
        return { subscriber: next, created: false };
      }
      const sub: Subscriber = {
        phone: input.phone,
        zip: input.zip,
        interests: union([], input.interests),
        site_ids: union([], input.site_ids),
        opted_in_at: nowNY(),
        channel: input.channel ?? "web",
      };
      try {
        await this.subscribers.insertOne({ ...sub });
        return { subscriber: sub, created: true };
      } catch (e) {
        // Two sign-ups for one phone at the same moment: the unique index won; retry as an update.
        if ((e as { code?: number }).code !== 11000) throw e;
      }
    }
    throw new Error("subscriber upsert conflict");
  }

  async deleteSubscriber(phone: string): Promise<boolean> {
    const r = await this.subscribers.deleteOne({ phone });
    return r.deletedCount === 1;
  }

  async nextDemoSeq(): Promise<number> {
    return ++this.demoSeq;
  }

  /**
   * POST /dev/reset in mongo mode: data/demo_reset.py (demo_state.epoch = now, demo_risk $unset on every site; the golden's
   * public risk is only re-written if it differs from its public-records score), then demo_risk $unset here too, the demo
   * sites' fixture risk restored (after a dev flip), and any site changed by a dev flip re-scored. Decisions, payments and
   * subscribers are NOT touched (they are the real Testnet history). Returns the cleared demo scores (demo_risk_updated)
   * and the sites whose PUBLIC risk changed (site_updated; normally none). Throws if demo_reset.py fails.
   */
  async reset(): Promise<ResetResult> {
    const changed = new Set<string>();
    const withDemo = await this.sites.find({ demo_risk: { $exists: true, $ne: null } }, { projection: { _id: 0, id: 1, demo_risk: 1 } }).toArray();
    const golden = (await this.demoState())?.golden_site_id;
    const riskKey = (x: unknown) => {
      const k = x as { level?: unknown; score?: unknown; reasons?: unknown } | null | undefined;
      return JSON.stringify([k?.level, k?.score, k?.reasons]);
    };
    const goldenBefore = golden ? riskKey((await this.sites.findOne({ id: golden }, { projection: { _id: 0, risk: 1 } }))?.risk) : null;
    const r = await runDataScript("demo_reset.py", []);
    if (r.code !== 0) {
      const tail = scrub(`${r.stderr}\n${r.stdout}`).trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(`data/demo_reset.py failed (${r.timedOut ? "timeout" : r.error ?? `exit ${r.code}`}): ${tail}`);
    }
    this.log.info(`demo_reset.py: ${scrub(r.stdout).trim().split(/\r?\n/).join(" | ")}`);
    await this.sites.updateMany({ demo_risk: { $exists: true } }, { $unset: { demo_risk: "" } });
    if (golden && riskKey((await this.sites.findOne({ id: golden }, { projection: { _id: 0, risk: 1 } }))?.risk) !== goldenBefore) changed.add(golden);

    for (const doc of demoSiteDocs()) {
      const cur = await this.sites.findOne({ id: doc.id }, { projection: { _id: 0, risk: 1 } });
      if (cur && JSON.stringify(cur.risk) !== JSON.stringify(doc.risk)) {
        await this.sites.updateOne({ id: doc.id }, { $set: { risk: doc.risk } });
        changed.add(doc.id);
      }
      this.flipped.delete(doc.id);
    }
    for (const id of [...this.flipped]) {
      if (await this.recomputeRisk(id, "dev reset after a dev flip")) changed.add(id);
      this.flipped.delete(id);
    }
    const demo_cleared = withDemo.map((x) => ({ site_id: x.id as string, demo_risk: null, previous_demo_risk: x.demo_risk as Risk }));
    return { risk_changed: [...changed], demo_cleared };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
