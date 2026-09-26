// The contract terms the co-signer relies on (payee EIN, testnet budget, term dates), PINNED like the payee registry.
// The agent process has write access to the same database in this hackathon setup, so the co-signer must not take a
// contract's terms from the live collection on each request:
//   - every contract in the collection at co-signer startup is pinned (canonical JSON + SHA-256, logged);
//   - on each /cosign the live document is re-read; if it was deleted or any pinned term changed -> registry_drift;
//   - a contract that did not exist at startup is admitted ONLY if it is flagged is_demo_data, pays an EIN in the
//     pinned registry, and has a small budget (<= LATE_CONTRACT_MAX_BUDGET_RLUSD); at most LATE_CONTRACT_MAX_COUNT
//     per co-signer lifetime. Once admitted it is pinned too. Anything else -> contract_not_found.
//     (This keeps `npm run demo over-contract` working against an already-running co-signer. The damage a forged
//     late contract can do is bounded by that budget, AUTO_LIMIT, the daily caps and the registry-wallet allowlist.)
// The agent's own audit uses liveContractResolver (no pin; record-keeping only).
import type { Db } from "mongodb";
import { canonicalJson, sha256Hex } from "../../../shared/hash";
import { COLL, findContract, type ContractDoc } from "./mongo";

export const LATE_CONTRACT_MAX_BUDGET_RLUSD = 25;
export const LATE_CONTRACT_MAX_COUNT = 20;

/** The contract terms the checks use. */
export interface ContractView {
  contract_id: string;
  nonprofit_ein: string;
  /** Testnet-scale stand-in for the remaining contract balance (RLUSD decimal string). */
  xrpl_budget_rlusd: string;
  /** YYYY-MM-DD; payments are refused outside start_date..end_date (contract_not_active). */
  start_date: string;
  end_date: string;
  is_demo_data: boolean;
}

export interface ContractResolution {
  contract: ContractView | null;
  /** Why `contract` is null (not in the collection, or a late contract that cannot be admitted). */
  missing: string | null;
  /** Non-null when the live document no longer matches the pinned terms (possible tampering). */
  drift: string | null;
  /** Extra context for the check detail (e.g. "admitted after startup"). */
  note: string | null;
}

export type ContractResolver = (contractId: string) => Promise<ContractResolution>;

export function contractView(d: Partial<ContractDoc>): ContractView {
  return {
    contract_id: String(d.contract_id ?? ""),
    nonprofit_ein: String(d.nonprofit_ein ?? ""),
    xrpl_budget_rlusd: String(d.xrpl_budget_rlusd ?? "0"),
    start_date: String(d.start_date ?? ""),
    end_date: String(d.end_date ?? ""),
    is_demo_data: d.is_demo_data === true,
  };
}

const TERM_FIELDS = ["nonprofit_ein", "xrpl_budget_rlusd", "start_date", "end_date", "is_demo_data"] as const;

function changedTerms(pinned: ContractView, live: ContractView): string[] {
  return TERM_FIELDS.filter((k) => pinned[k] !== live[k]).map((k) => `${k} ${JSON.stringify(pinned[k])} -> ${JSON.stringify(live[k])}`);
}

/** Agent-side audit: reads the live collection, no pinning. */
export function liveContractResolver(db: Db): ContractResolver {
  return async (id) => {
    const doc = await findContract(db, id);
    return doc
      ? { contract: contractView(doc), missing: null, drift: null, note: null }
      : { contract: null, missing: `contract ${id} (memo ctr) is not in the contracts collection`, drift: null, note: null };
  };
}

export class ContractPins {
  private pins = new Map<string, { view: ContractView; late_admitted_at?: string }>();
  private lateCount = 0;
  readonly sha256: string;
  readonly read_at: string;
  readonly count: number;

  private constructor(views: ContractView[]) {
    const sorted = [...views].sort((a, b) => (a.contract_id < b.contract_id ? -1 : a.contract_id > b.contract_id ? 1 : 0));
    for (const v of sorted) this.pins.set(v.contract_id, { view: v });
    this.sha256 = sha256Hex(canonicalJson(sorted));
    this.read_at = new Date().toISOString();
    this.count = sorted.length;
  }

  static async load(db: Db): Promise<ContractPins> {
    const docs = await db.collection<ContractDoc>(COLL.contracts).find({}, { projection: { _id: 0 } }).toArray();
    return new ContractPins(docs.map(contractView));
  }

  get lateAdmitted(): number {
    return this.lateCount;
  }

  /** Resolver for /cosign. `registryEins`: EINs in the pinned registry snapshot (late contracts must pay one of them). */
  resolver(db: Db, registryEins: ReadonlySet<string>): ContractResolver {
    return async (id) => {
      const doc = await findContract(db, id);
      const live = doc ? contractView(doc) : null;
      const pin = this.pins.get(id);
      if (pin) {
        const note = pin.late_admitted_at ? `contract admitted after co-signer startup at ${pin.late_admitted_at} and pinned since` : null;
        if (!live) return { contract: pin.view, missing: null, drift: `contract ${id} was deleted from the database after the co-signer pinned it`, note };
        const changed = changedTerms(pin.view, live);
        return { contract: pin.view, missing: null, drift: changed.length ? `contract ${id} changed since it was pinned (${changed.join("; ")})` : null, note };
      }
      if (!live) return { contract: null, missing: `contract ${id} (memo ctr) is not in the contracts collection`, drift: null, note: null };
      // A contract created after startup: admit only small, demo-flagged contracts for a registry payee.
      const why: string[] = [];
      if (!live.is_demo_data) why.push("it is not flagged is_demo_data");
      const budget = /^\d{1,12}(\.\d{1,6})?$/.test(live.xrpl_budget_rlusd) ? Number(live.xrpl_budget_rlusd) : NaN;
      if (!(budget > 0 && budget <= LATE_CONTRACT_MAX_BUDGET_RLUSD)) why.push(`its xrpl_budget_rlusd ${live.xrpl_budget_rlusd} is not in (0, ${LATE_CONTRACT_MAX_BUDGET_RLUSD.toFixed(2)}]`);
      if (!registryEins.has(live.nonprofit_ein)) why.push(`its payee EIN ${live.nonprofit_ein} is not in the pinned registry`);
      if (this.lateCount >= LATE_CONTRACT_MAX_COUNT) why.push(`${LATE_CONTRACT_MAX_COUNT} contracts were already admitted since startup`);
      if (why.length) {
        return { contract: null, missing: `contract ${id} did not exist when the co-signer started and cannot be admitted late: ${why.join("; ")} (restart the co-signer to pin it)`, drift: null, note: null };
      }
      const at = new Date().toISOString();
      this.pins.set(id, { view: live, late_admitted_at: at });
      this.lateCount++;
      return {
        contract: live,
        missing: null,
        drift: null,
        note: `contract created after co-signer startup; admitted at ${at} as a small demo contract (budget ${budget.toFixed(2)} <= late-contract cap ${LATE_CONTRACT_MAX_BUDGET_RLUSD.toFixed(2)} RLUSD) and pinned from now on`,
      };
    };
  }
}
