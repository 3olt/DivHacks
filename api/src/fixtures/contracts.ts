import type { Contract, Payment } from "../../../shared/contracts";

// DEMO contracts in Checkbook NYC's shape. IDs follow Checkbook's "CT1-<agency>-<FY><7 digits>" pattern
// (069 = HRA, 071 = DHS, 260 = DYCD) but are made up. spent_to_date is the sum of the Checkbook-style
// payments below, so the two always agree. Phase 4 replaces all of this with real Checkbook NYC records.
const SOURCE = "demo fixture (Phase 4 replaces with Checkbook NYC)";
const SOURCE_URL = "https://www.checkbooknyc.com/";

interface ContractSeed {
  contract_id: string;
  agency_code: "HRA" | "DHS" | "DYCD";
  nonprofit_ein: string;
  amount: number;
  start_date: string;
  end_date: string;
  registered_date: string | null;
  purpose: string;
  /** Checkbook-style payments: [issue date YYYY-MM-DD, amount USD]. */
  checkbook: [string, number][];
}

const SEEDS: ContractSeed[] = [
  // site_001 (golden): current 3-year contract + the completed previous cycle
  {
    contract_id: "CT1-069-20261409087",
    agency_code: "HRA",
    nonprofit_ein: "00-0000001",
    amount: 1_240_000,
    start_date: "2025-07-01",
    end_date: "2028-06-30",
    registered_date: "2025-09-08",
    purpose: "Emergency food assistance: pantry operations and bulk food purchasing",
    checkbook: [
      ["2025-10-15", 62_000],
      ["2026-01-22", 58_000],
      ["2026-04-30", 66_000],
    ],
  },
  {
    contract_id: "CT1-069-20231187742",
    agency_code: "HRA",
    nonprofit_ein: "00-0000001",
    amount: 410_000,
    start_date: "2022-07-01",
    end_date: "2025-06-30",
    registered_date: "2022-10-14",
    purpose: "Emergency food assistance, FY2023-FY2025 cycle (completed)",
    checkbook: [
      ["2022-12-20", 120_000],
      ["2023-06-15", 95_000],
      ["2024-01-10", 105_000],
      ["2024-11-05", 90_000],
    ],
  },
  {
    contract_id: "CT1-069-20271522304",
    agency_code: "HRA",
    nonprofit_ein: "00-0000002",
    amount: 520_000,
    start_date: "2026-07-01",
    end_date: "2027-06-30",
    registered_date: null,
    purpose: "Community food distribution: weekly grocery giveaways",
    checkbook: [],
  },
  {
    contract_id: "CT1-260-20241298815",
    agency_code: "DYCD",
    nonprofit_ein: "00-0000003",
    amount: 690_000,
    start_date: "2024-07-01",
    end_date: "2027-06-30",
    registered_date: "2024-06-20",
    purpose: "After-school STEM programming (middle school)",
    checkbook: [
      ["2024-09-30", 170_000],
      ["2025-03-14", 165_000],
      ["2025-11-21", 170_000],
    ],
  },
  {
    contract_id: "CT1-069-20261409311",
    agency_code: "HRA",
    nonprofit_ein: "00-0000004",
    amount: 880_000,
    start_date: "2025-07-01",
    end_date: "2027-06-30",
    registered_date: "2025-08-01",
    purpose: "Emergency food assistance: pantry and hot-meal program",
    checkbook: [
      ["2025-10-02", 110_000],
      ["2026-02-11", 112_400],
      ["2026-06-19", 112_000],
    ],
  },
  {
    contract_id: "CT1-071-20261388406",
    agency_code: "DHS",
    nonprofit_ein: "00-0000005",
    amount: 6_400_000,
    start_date: "2025-07-01",
    end_date: "2028-06-30",
    registered_date: "2025-11-20",
    purpose: "Families with children shelter: operations and case management",
    checkbook: [
      ["2026-01-09", 288_000],
      ["2026-05-22", 288_000],
    ],
  },
  {
    contract_id: "CT1-260-20241301452",
    agency_code: "DYCD",
    nonprofit_ein: "00-0000006",
    amount: 540_000,
    start_date: "2024-07-01",
    end_date: "2027-06-30",
    registered_date: "2024-06-18",
    purpose: "After-school coding and robotics program",
    checkbook: [
      ["2024-10-10", 126_000],
      ["2025-04-18", 126_000],
      ["2026-01-15", 126_000],
    ],
  },
  {
    contract_id: "CT1-069-20271522519",
    agency_code: "HRA",
    nonprofit_ein: "00-0000007",
    amount: 760_000,
    start_date: "2026-07-01",
    end_date: "2027-06-30",
    registered_date: null,
    purpose: "Emergency food assistance: pantry operations (Brownsville)",
    checkbook: [],
  },
  {
    contract_id: "CT1-071-20261390077",
    agency_code: "DHS",
    nonprofit_ein: "00-0000008",
    amount: 3_900_000,
    start_date: "2025-07-01",
    end_date: "2028-06-30",
    registered_date: "2025-08-15",
    purpose: "Adult shelter operations and housing placement services",
    checkbook: [
      ["2025-10-30", 390_000],
      ["2026-02-26", 390_000],
      ["2026-06-25", 390_000],
    ],
  },
  {
    contract_id: "CT1-260-20251344730",
    agency_code: "DYCD",
    nonprofit_ein: "00-0000009",
    amount: 310_000,
    start_date: "2024-07-01",
    end_date: "2027-06-30",
    registered_date: "2024-07-01",
    purpose: "Youth sports and community events",
    checkbook: [
      ["2024-11-08", 74_400],
      ["2025-05-02", 74_400],
      ["2026-01-30", 74_400],
    ],
  },
  {
    contract_id: "CT1-069-20261409502",
    agency_code: "HRA",
    nonprofit_ein: "00-0000007",
    amount: 450_000,
    start_date: "2025-07-01",
    end_date: "2027-06-30",
    registered_date: "2025-07-21",
    purpose: "Community food distribution: weekend grocery giveaways (Flatbush)",
    checkbook: [
      ["2025-11-14", 101_250],
      ["2026-04-03", 101_250],
    ],
  },
  {
    contract_id: "CT1-069-20251350128",
    agency_code: "HRA",
    nonprofit_ein: "00-0000010",
    amount: 600_000,
    start_date: "2024-07-01",
    end_date: "2027-06-30",
    registered_date: "2024-06-25",
    purpose: "Emergency food assistance: multilingual pantry",
    checkbook: [
      ["2024-10-18", 146_000],
      ["2025-06-06", 146_000],
      ["2026-02-20", 146_000],
    ],
  },
  {
    contract_id: "CT1-071-20261391864",
    agency_code: "DHS",
    nonprofit_ein: "00-0000011",
    amount: 5_200_000,
    start_date: "2025-07-01",
    end_date: "2028-06-30",
    registered_date: "2025-09-03",
    purpose: "Adult families shelter operations",
    checkbook: [
      ["2025-12-12", 676_000],
      ["2026-05-08", 676_000],
    ],
  },
  {
    contract_id: "CT1-260-20271530611",
    agency_code: "DYCD",
    nonprofit_ein: "00-0000012",
    amount: 280_000,
    start_date: "2026-07-01",
    end_date: "2027-06-30",
    registered_date: null,
    purpose: "After-school program (elementary)",
    checkbook: [],
  },
  {
    contract_id: "CT1-069-20251350877",
    agency_code: "HRA",
    nonprofit_ein: "00-0000013",
    amount: 350_000,
    start_date: "2024-07-01",
    end_date: "2027-06-30",
    registered_date: "2024-06-12",
    purpose: "Emergency food assistance: community larder",
    checkbook: [
      ["2025-01-17", 133_000],
      ["2025-12-05", 133_000],
    ],
  },
  {
    contract_id: "CT1-069-20261409745",
    agency_code: "HRA",
    nonprofit_ein: "00-0000014",
    amount: 240_000,
    start_date: "2025-07-01",
    end_date: "2027-06-30",
    registered_date: "2025-09-29",
    purpose: "Community food events and seasonal produce distribution",
    checkbook: [
      ["2025-12-19", 60_000],
      ["2026-05-29", 60_000],
    ],
  },
];

const dec = (n: number) => n.toFixed(2);

export const CONTRACTS: Contract[] = SEEDS.map((s) => ({
  contract_id: s.contract_id,
  agency_code: s.agency_code,
  nonprofit_ein: s.nonprofit_ein,
  amount: dec(s.amount),
  start_date: s.start_date,
  end_date: s.end_date,
  registered_date: s.registered_date,
  spent_to_date: dec(s.checkbook.reduce((sum, [, amt]) => sum + amt, 0)),
  purpose: s.purpose,
  source: SOURCE,
  source_url: SOURCE_URL,
}));

let cbSeq = 0;
export const CHECKBOOK_PAYMENTS: Payment[] = SEEDS.flatMap((s) =>
  s.checkbook.map(([date, amount]) => ({
    payment_id: `fx_cb_${String(++cbSeq).padStart(4, "0")}`,
    source: "checkbook" as const,
    contract_id: s.contract_id,
    payee_ein: s.nonprofit_ein,
    amount: dec(amount),
    currency: "USD" as const,
    date,
    status: "released" as const,
    is_demo_data: true,
  })),
);

export const CONTRACTS_BY_ID = new Map(CONTRACTS.map((c) => [c.contract_id, c]));
