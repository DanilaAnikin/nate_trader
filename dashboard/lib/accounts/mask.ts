/**
 * Broker account-number masking.
 *
 * The full Alpaca account number is a broker identifier and must never reach
 * the browser — not in an API body, not in Server Component props, and not in
 * the RSC Flight payload. Only the last four characters are ever exposed.
 */
export function maskAccountNumber(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 4) return null;
  return `••••${trimmed.slice(-4)}`;
}
