import type { Nonprofit } from "../../../shared/contracts";
import { REGISTRY_WALLETS } from "./wallets";

// FICTIONAL organizations (names end in "(demo)"; EINs 00-00000NN are not real EINs). Financials are
// made-up but plausible; source_url is a placeholder for the ProPublica Nonprofit Explorer page that
// Phase 4 fills in per real EIN. Addresses are real NYC streets used only to place the fictional
// organizations plausibly (see sites.ts); no real organization is implied to be at them.
const PP = "https://projects.propublica.org/nonprofits/";

const valid = (ein: string, expires: string) => ({
  address: REGISTRY_WALLETS[ein],
  credential_status: "valid" as const,
  credential_expires: expires,
  bank_verified: true,
});

export const NONPROFITS: Nonprofit[] = [
  {
    ein: "00-0000001",
    name: "Burnside Heights Food Collective (demo)",
    address: "30 W Burnside Ave, Bronx, NY 10453",
    service_types: ["food_pantry"],
    financials: { fiscal_year: 2023, revenue: 2_850_000, expenses: 2_790_000, net_assets: 1_020_000, cash_months: 3.6, source_url: PP },
    wallet: valid("00-0000001", "2027-03-31T23:59:59-04:00"),
  },
  {
    ein: "00-0000002",
    name: "South Bronx Table Fund (demo)",
    address: "412 E 138th St, Bronx, NY 10454",
    service_types: ["grocery_giveaway", "food_pantry"],
    financials: { fiscal_year: 2023, revenue: 1_340_000, expenses: 1_390_000, net_assets: 210_000, cash_months: 1.4, source_url: PP },
    wallet: { address: REGISTRY_WALLETS["00-0000002"], credential_status: "none", bank_verified: false },
  },
  {
    ein: "00-0000003",
    name: "Bronx Riverbend Youth Works (demo)",
    address: "2530 Webster Ave, Bronx, NY 10458",
    service_types: ["youth_program"],
    financials: { fiscal_year: 2024, revenue: 1_760_000, expenses: 1_640_000, net_assets: 1_150_000, cash_months: 5.2, source_url: PP },
    wallet: valid("00-0000003", "2027-06-30T23:59:59-04:00"),
  },
  {
    ein: "00-0000004",
    name: "El Barrio Mesa Comunitaria (demo)",
    address: "236 E 116th St, New York, NY 10029",
    service_types: ["food_pantry"],
    financials: { fiscal_year: 2023, revenue: 980_000, expenses: 955_000, net_assets: 310_000, cash_months: 2.8, source_url: PP },
    wallet: valid("00-0000004", "2027-01-31T23:59:59-05:00"),
  },
  {
    ein: "00-0000005",
    name: "Orchard Harbor Housing Services (demo)",
    address: "135 Norfolk St, New York, NY 10002",
    service_types: ["shelter"],
    financials: { fiscal_year: 2023, revenue: 14_200_000, expenses: 14_650_000, net_assets: 1_900_000, cash_months: 1.1, source_url: PP },
    wallet: {
      address: REGISTRY_WALLETS["00-0000005"],
      credential_status: "expired",
      credential_expires: "2026-08-31T23:59:59-04:00",
      bank_verified: true,
    },
  },
  {
    ein: "00-0000006",
    name: "Upper Manhattan STEM Circle (demo)",
    address: "520 W 163rd St, New York, NY 10032",
    service_types: ["youth_program"],
    financials: { fiscal_year: 2024, revenue: 1_120_000, expenses: 1_010_000, net_assets: 890_000, cash_months: 6.5, source_url: PP },
    wallet: valid("00-0000006", "2027-06-30T23:59:59-04:00"),
  },
  {
    ein: "00-0000007",
    name: "Pitkin Commons Food Network (demo)",
    address: "1615 Pitkin Ave, Brooklyn, NY 11212",
    service_types: ["food_pantry", "grocery_giveaway"],
    financials: { fiscal_year: 2023, revenue: 2_240_000, expenses: 2_300_000, net_assets: 420_000, cash_months: 1.7, source_url: PP },
    wallet: valid("00-0000007", "2026-12-31T23:59:59-05:00"),
  },
  {
    ein: "00-0000008",
    name: "Nostrand Bridge Housing (demo)",
    address: "1401 Fulton St, Brooklyn, NY 11216",
    service_types: ["shelter"],
    financials: { fiscal_year: 2023, revenue: 9_800_000, expenses: 9_650_000, net_assets: 2_600_000, cash_months: 2.5, source_url: PP },
    wallet: valid("00-0000008", "2027-02-28T23:59:59-05:00"),
  },
  {
    ein: "00-0000009",
    name: "Brooklyn Harborview Youth League (demo)",
    address: "521 44th St, Brooklyn, NY 11220",
    service_types: ["youth_program", "event"],
    financials: { fiscal_year: 2024, revenue: 640_000, expenses: 598_000, net_assets: 305_000, cash_months: 4.4, source_url: PP },
    wallet: valid("00-0000009", "2027-06-30T23:59:59-04:00"),
  },
  {
    ein: "00-0000010",
    name: "Roosevelt Corridor Food Share (demo)",
    address: "82-01 37th Ave, Jackson Heights, NY 11372",
    service_types: ["food_pantry"],
    financials: { fiscal_year: 2024, revenue: 1_480_000, expenses: 1_395_000, net_assets: 870_000, cash_months: 5.5, source_url: PP },
    wallet: { address: REGISTRY_WALLETS["00-0000010"], credential_status: "none", bank_verified: true },
  },
  {
    ein: "00-0000011",
    name: "Hillside Crossing Shelter Services (demo)",
    address: "164-10 Hillside Ave, Jamaica, NY 11432",
    service_types: ["shelter"],
    financials: { fiscal_year: 2023, revenue: 11_300_000, expenses: 11_050_000, net_assets: 3_400_000, cash_months: 3.0, source_url: PP },
    wallet: valid("00-0000011", "2027-03-31T23:59:59-04:00"),
  },
  {
    ein: "00-0000012",
    name: "Rockaway Tide Youth Collective (demo)",
    address: "19-40 Mott Ave, Far Rockaway, NY 11691",
    service_types: ["youth_program"],
    financials: { fiscal_year: 2023, revenue: 410_000, expenses: 436_000, net_assets: 48_000, cash_months: 1.2, source_url: PP },
    wallet: { address: REGISTRY_WALLETS["00-0000012"], credential_status: "none", bank_verified: false },
  },
  {
    ein: "00-0000013",
    name: "Kill Van Kull Community Larder (demo)",
    address: "85 Victory Blvd, Staten Island, NY 10301",
    service_types: ["food_pantry"],
    financials: { fiscal_year: 2024, revenue: 720_000, expenses: 655_000, net_assets: 610_000, cash_months: 7.1, source_url: PP },
    // no wallet registered yet
  },
  {
    ein: "00-0000014",
    name: "Port Richmond Harvest Circle (demo)",
    address: "175 Port Richmond Ave, Staten Island, NY 10302",
    service_types: ["event", "food_pantry"],
    // no IRS 990 on file and no wallet registered yet
  },
];
