import type { Subscriber } from "../../../shared/contracts";

// Seed subscribers use 555-01XX numbers, which are reserved for fictional use.
export const FIXTURE_SUBSCRIBERS: Subscriber[] = [
  {
    phone: "+12125550142",
    zip: "10453",
    interests: ["food_pantry"],
    site_ids: ["site_001"],
    opted_in_at: "2026-09-24T18:12:00-04:00",
    channel: "imessage",
  },
  {
    phone: "+17185550117",
    zip: "11212",
    interests: ["food_pantry", "grocery_giveaway"],
    site_ids: ["site_007", "site_010"],
    opted_in_at: "2026-09-25T09:41:00-04:00",
    channel: "web",
  },
];
