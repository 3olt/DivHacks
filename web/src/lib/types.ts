// Web-only types. Shared API types live in ./contracts (copy of shared/contracts.ts).
import type { SiteType } from "./contracts";

// Sign-up profile for eligibility-based event alerts. Separate from the money map.
// The API's Subscriber stores phone, zip, interests, site_ids; the rest stays in web until the API adds a profile field.
export interface SubscriberProfile {
  phone: string; // E.164, e.g. +12125551234
  first_name: string;
  age: number | null;
  street_address: string;
  zip: string;
  borough: string;
  household_size: number | null;
  language: string;
  interests: SiteType[];
  // Household benefits (TEFAP categorical eligibility in NY): snap | wic | tanf | medicaid | ssi
  benefits: string[];
  consent_sms: boolean;
  created_at: string;
}
