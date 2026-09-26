/**
 * Normalize a US phone number to E.164 (+1XXXXXXXXXX). Accepts "(212) 555-0142", "212-555-0142",
 * "2125550142", "12125550142", "+1 212 555 0142". Returns null if it is not a valid NANP number.
 */
export function normalizeUsPhone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  if (trimmed.startsWith("+") && !trimmed.replace(/[\s().-]/g, "").startsWith("+1")) return null;
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  // NANP: area code and exchange cannot start with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return `+1${digits}`;
}
