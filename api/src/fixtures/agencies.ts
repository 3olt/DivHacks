import type { AgencyStats } from "../../../shared/contracts";

// DEMO figures in the ballpark of the Comptroller's reporting (roughly 9 in 10 human-service contracts
// registered late). Phase 4 replaces them with the NYC Comptroller's actual per-agency numbers.
const SOURCE = "demo fixture; Phase 4 uses NYC Comptroller data";
const SOURCE_URL = "https://comptroller.nyc.gov/services/for-the-public/late-contracts-dashboard/";

export const AGENCIES: AgencyStats[] = [
  {
    code: "HRA",
    name: "Human Resources Administration",
    pct_contracts_registered_late: 0.89,
    avg_days_registered_late: 118,
    fiscal_year: 2025,
    source: SOURCE,
    source_url: SOURCE_URL,
    is_demo_data: true,
  },
  {
    code: "DHS",
    name: "Department of Homeless Services",
    pct_contracts_registered_late: 0.93,
    avg_days_registered_late: 142,
    fiscal_year: 2025,
    source: SOURCE,
    source_url: SOURCE_URL,
    is_demo_data: true,
  },
  {
    code: "DYCD",
    name: "Department of Youth and Community Development",
    pct_contracts_registered_late: 0.78,
    avg_days_registered_late: 96,
    fiscal_year: 2025,
    source: SOURCE,
    source_url: SOURCE_URL,
    is_demo_data: true,
  },
];
