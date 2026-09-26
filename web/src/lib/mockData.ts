// Placeholder demo data. Organization names, EINs, contracts, wallets and tx hashes are fictional.
// Replace with real data from the data pipeline (Checkbook NYC / ProPublica / NYC Open Data).
import type { Contract, Nonprofit, Payment, Site } from "./types";

export const nonprofits: Nonprofit[] = [
  { ein: "00-0000001", name: "Harlem Community Pantry (demo)", cash_reserve_months: 2, program_expense_pct: 84, annual_revenue_usd: 3_200_000, xrpl_wallet: "rDEMOwallet1111111111111111111", credential_valid_until: "2026-12-31" },
  { ein: "00-0000002", name: "Bronx Family Food Network (demo)", cash_reserve_months: 1, program_expense_pct: 88, annual_revenue_usd: 5_900_000, xrpl_wallet: "rDEMOwallet2222222222222222222", credential_valid_until: "2026-12-31" },
  { ein: "00-0000003", name: "Brooklyn Youth Futures (demo)", cash_reserve_months: 6, program_expense_pct: 79, annual_revenue_usd: 1_800_000, xrpl_wallet: "rDEMOwallet3333333333333333333", credential_valid_until: "2027-03-31" },
  { ein: "00-0000004", name: "Queens Seniors Together (demo)", cash_reserve_months: 4, program_expense_pct: 81, annual_revenue_usd: 2_400_000, xrpl_wallet: null, credential_valid_until: null },
  { ein: "00-0000005", name: "Lower East Side Shelter Alliance (demo)", cash_reserve_months: 1, program_expense_pct: 91, annual_revenue_usd: 12_500_000, xrpl_wallet: "rDEMOwallet5555555555555555555", credential_valid_until: "2026-11-30" },
  { ein: "00-0000006", name: "Staten Island Harvest (demo)", cash_reserve_months: 8, program_expense_pct: 86, annual_revenue_usd: 900_000, xrpl_wallet: "rDEMOwallet6666666666666666666", credential_valid_until: "2027-01-31" },
];

export const contracts: Contract[] = [
  { contract_id: "DEMO-HRA-0001", agency: "Human Resources Administration", agency_avg_days_late: 110, payee_ein: "00-0000001", purpose: "Emergency food assistance", value_usd: 850_000, paid_to_date_usd: 310_000, registered: true, start_date: "2026-07-01", days_payment_late: 74 },
  { contract_id: "DEMO-HRA-0002", agency: "Human Resources Administration", agency_avg_days_late: 110, payee_ein: "00-0000002", purpose: "Food pantry operations", value_usd: 1_400_000, paid_to_date_usd: 120_000, registered: false, start_date: "2026-07-01", days_payment_late: 120 },
  { contract_id: "DEMO-DYCD-0003", agency: "Department of Youth and Community Development", agency_avg_days_late: 45, payee_ein: "00-0000003", purpose: "After-school programming", value_usd: 600_000, paid_to_date_usd: 280_000, registered: true, start_date: "2026-07-01", days_payment_late: 0 },
  { contract_id: "DEMO-DFTA-0004", agency: "Department for the Aging", agency_avg_days_late: 60, payee_ein: "00-0000004", purpose: "Senior center meals", value_usd: 720_000, paid_to_date_usd: 300_000, registered: true, start_date: "2026-07-01", days_payment_late: 21 },
  { contract_id: "DEMO-DHS-0005", agency: "Department of Homeless Services", agency_avg_days_late: 120, payee_ein: "00-0000005", purpose: "Shelter services", value_usd: 4_800_000, paid_to_date_usd: 900_000, registered: false, start_date: "2026-07-01", days_payment_late: 146 },
  { contract_id: "DEMO-HRA-0006", agency: "Human Resources Administration", agency_avg_days_late: 110, payee_ein: "00-0000006", purpose: "Community food distribution", value_usd: 250_000, paid_to_date_usd: 180_000, registered: true, start_date: "2026-07-01", days_payment_late: 0 },
];

export const sites: Site[] = [
  { id: "site_001", name: "Harlem Community Pantry", type: "food_pantry", address: "W 125th St, Manhattan", location: { type: "Point", coordinates: [-73.9496, 40.8090] }, nonprofit_ein: "00-0000001", next_event: { title: "Free groceries", starts_at: "2026-09-27T10:00:00-04:00" }, risk: { level: "yellow", score: 62, reasons: ["HRA averages 110 days late", "Payments 74 days late", "2 months cash reserves"] }, is_demo_data: true },
  { id: "site_002", name: "Bronx Family Food Network", type: "grocery_giveaway", address: "E 149th St, Bronx", location: { type: "Point", coordinates: [-73.9170, 40.8160] }, nonprofit_ein: "00-0000002", next_event: { title: "Saturday grocery giveaway", starts_at: "2026-10-03T09:00:00-04:00" }, risk: { level: "red", score: 88, reasons: ["Contract not registered past start date", "Payments 120 days late", "1 month cash reserves"] }, is_demo_data: true },
  { id: "site_003", name: "Brooklyn Youth Futures", type: "event", address: "Fulton St, Brooklyn", location: { type: "Point", coordinates: [-73.9442, 40.6803] }, nonprofit_ein: "00-0000003", next_event: { title: "After-school open house", starts_at: "2026-09-30T16:00:00-04:00" }, risk: { level: "green", score: 18, reasons: ["Payments on time", "6 months cash reserves"] }, is_demo_data: true },
  { id: "site_004", name: "Queens Seniors Together", type: "service", address: "Roosevelt Ave, Queens", location: { type: "Point", coordinates: [-73.8830, 40.7470] }, nonprofit_ein: "00-0000004", next_event: { title: "Community lunch", starts_at: "2026-09-29T12:00:00-04:00" }, risk: { level: "yellow", score: 45, reasons: ["Payments 21 days late", "No verified XRPL wallet yet"] }, is_demo_data: true },
  { id: "site_005", name: "Lower East Side Shelter Alliance", type: "service", address: "Delancey St, Manhattan", location: { type: "Point", coordinates: [-73.9870, 40.7180] }, nonprofit_ein: "00-0000005", next_event: null, risk: { level: "red", score: 91, reasons: ["DHS averages 120 days late", "Contract not registered past start date", "1 month cash reserves"] }, is_demo_data: true },
  { id: "site_006", name: "Staten Island Harvest", type: "food_pantry", address: "Victory Blvd, Staten Island", location: { type: "Point", coordinates: [-74.0776, 40.6360] }, nonprofit_ein: "00-0000006", next_event: { title: "Fresh produce pickup", starts_at: "2026-09-28T11:00:00-04:00" }, risk: { level: "green", score: 12, reasons: ["Payments on time", "8 months cash reserves"] }, is_demo_data: true },
];

export const payments: Payment[] = [
  { invoice_id: "INV-DEMO-0001", contract_id: "DEMO-DYCD-0003", payee_ein: "00-0000003", payee_wallet: "rDEMOwallet3333333333333333333", amount_xrp: "25", status: "released", refusal_reason: null, xrpl_tx_hash: null, agent_reasoning: "Milestone verified; within contract cap; credential valid", created_at: "2026-09-20T14:00:00-04:00" },
  { invoice_id: "INV-DEMO-0002", contract_id: "DEMO-HRA-0001", payee_ein: "00-0000001", payee_wallet: "rATTACKERwallet999999999999999", amount_xrp: "40", status: "refused", refusal_reason: "Wallet not credentialed for this EIN", xrpl_tx_hash: null, agent_reasoning: "Invoice requested payment to a new wallet; payee changes require out-of-band confirmation", created_at: "2026-09-24T09:30:00-04:00" },
];
