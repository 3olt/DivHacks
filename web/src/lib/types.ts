// Shared data contracts. Keep in sync with context.md ("Shared data contracts").

export type RiskLevel = "green" | "yellow" | "red";

export type SiteType = "food_pantry" | "grocery_giveaway" | "event" | "service";

export interface Site {
  id: string;
  name: string;
  type: SiteType;
  address: string;
  // GeoJSON order: [lng, lat] (matches MongoDB 2dsphere)
  location: { type: "Point"; coordinates: [number, number] };
  nonprofit_ein: string;
  next_event: { title: string; starts_at: string } | null;
  risk: { level: RiskLevel; score: number; reasons: string[] };
  is_demo_data: boolean;
}

export interface Nonprofit {
  ein: string;
  name: string;
  cash_reserve_months: number;
  program_expense_pct: number;
  annual_revenue_usd: number;
  xrpl_wallet: string | null;
  credential_valid_until: string | null;
}

export interface Contract {
  contract_id: string;
  agency: string;
  agency_avg_days_late: number;
  payee_ein: string;
  purpose: string;
  value_usd: number;
  paid_to_date_usd: number;
  registered: boolean;
  start_date: string;
  days_payment_late: number;
}

export type PaymentStatus = "released" | "held_escrow" | "refused";

export interface Payment {
  invoice_id: string;
  contract_id: string;
  payee_ein: string;
  payee_wallet: string;
  amount_xrp: string;
  status: PaymentStatus;
  refusal_reason: string | null;
  xrpl_tx_hash: string | null;
  agent_reasoning: string;
  created_at: string;
}

export interface SiteDetail {
  site: Site;
  nonprofit: Nonprofit | null;
  contracts: Contract[];
  payments: Payment[];
}

export type AlertInterest = "food" | "youth" | "seniors" | "events";

// Basic intake info food drives typically ask for. Extend as needed.
export interface Subscriber {
  phone: string; // E.164, e.g. +12125551234
  first_name: string;
  age: number | null;
  street_address: string;
  zip: string;
  borough: string;
  household_size: number | null;
  language: string;
  interests: AlertInterest[];
  site_ids: string[]; // locations the user follows
  consent_sms: boolean;
  created_at: string;
  // TODO: eligibility (SNAP/WIC), dietary needs, accessibility needs
}
