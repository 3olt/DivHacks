// Time helpers. Runtime timestamps are ISO 8601 in New York local time with an explicit offset,
// e.g. "2026-09-26T14:03:11-04:00", to match the fixture data.

const NY_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

/** Current (or given) instant as an ISO 8601 string in America/New_York, e.g. "2026-09-26T14:03:11-04:00". */
export function nowNY(date: Date = new Date()): string {
  const parts: Record<string, string> = {};
  for (const p of NY_FORMAT.formatToParts(date)) parts[p.type] = p.value;
  const offset = (parts.timeZoneName ?? "GMT").replace("GMT", "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/** The New York calendar date (YYYY-MM-DD) of the given instant. */
export function dateNY(date: Date = new Date()): string {
  return nowNY(date).slice(0, 10);
}

const DAY_MS = 86_400_000;

/** Whole days from date-only string `a` to date-only string `b` (YYYY-MM-DD). Negative if b is before a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Milliseconds since epoch for either a date-only string or a full ISO timestamp. */
export function toMillis(s: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
}
