import type { SiteType } from "./types";

export const SITE_TYPE_LABELS: Record<SiteType, string> = {
  food_pantry: "Food pantry",
  grocery_giveaway: "Grocery giveaway",
  event: "Community event",
  service: "Service",
};

export function formatEventTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
