import type { RiskLevel } from "./contracts";

export const RISK_COLORS: Record<RiskLevel, string> = {
  green: "#16a34a",
  yellow: "#eab308",
  red: "#dc2626",
};

export const RISK_LABELS: Record<RiskLevel, string> = {
  green: "Funded, on track",
  yellow: "Payments running late",
  red: "At risk of delay",
};
