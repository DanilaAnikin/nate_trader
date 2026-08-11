import "server-only";
import { randomUUID } from "node:crypto";

/**
 * What a failing request may tell the browser, and what it may not.
 *
 * A database error message is written for an operator reading a server log,
 * and it says operator things: the constraint that fired, the relation, and —
 * because these RPCs take them as arguments — Vault UUIDs, operation UUIDs and
 * broker account numbers. Forwarding it to the client publishes all of that to
 * whoever provoked the error, which for a signed-in tenant is trivial.
 *
 * So the response carries two things: a **stable reason code** the UI can
 * branch on, and an **opaque incident id** the operator can grep for. The
 * detail goes to the server log beside that id, and nowhere else.
 */

/** Codes the UI is allowed to see. Stable: they are part of the contract. */
export type IncidentCode =
  | "INVALID_INPUT"
  | "INVALID_KEYS"
  | "BROKER_UNREACHABLE"
  | "BROKER_ERROR"
  | "CONFLICT"
  | "NOT_FOUND"
  | "INDETERMINATE"
  | "INTERNAL";

export interface SanitizedFailure {
  readonly code: IncidentCode;
  /** Fixed prose per code. Never interpolates anything from the failure. */
  readonly error: string;
  /** Random per occurrence; correlates the response with the server log. */
  readonly incidentId: string;
}

const MESSAGE: Record<IncidentCode, string> = {
  INVALID_INPUT: "The request was not valid.",
  INVALID_KEYS: "Alpaca rejected these credentials.",
  BROKER_UNREACHABLE: "Alpaca could not be reached.",
  BROKER_ERROR: "Alpaca returned an error.",
  CONFLICT: "That operation conflicts with the current state of the account.",
  NOT_FOUND: "Not found.",
  INDETERMINATE:
    "The outcome could not be established. Retrying the same request is safe.",
  INTERNAL: "The request could not be completed.",
};

/**
 * Log the detail server-side, return the sanitized shape.
 *
 * The detail is logged even when it looks harmless: deciding case by case is
 * how a Vault id ends up in a response, and the log is the right place for
 * all of it regardless.
 */
export function incident(
  code: IncidentCode,
  detail: string,
  context: Record<string, unknown> = {},
): SanitizedFailure {
  const incidentId = randomUUID();
  console.error(
    JSON.stringify({
      level: "error",
      incidentId,
      code,
      detail,
      ...context,
    }),
  );
  return { code, error: MESSAGE[code], incidentId };
}

/**
 * Patterns that must never appear in anything the browser receives.
 *
 * Exported so the canary tests assert against exactly the same list the code
 * is written to satisfy, rather than a second copy that can drift.
 */
export const FORBIDDEN_IN_RESPONSES: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "a UUID (Vault secret, operation or account internals)",
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  },
  { name: "a raw PostgreSQL SQLSTATE", pattern: /\b(23505|23503|23514|22023|P0001|P0002)\b/ },
  { name: "a PostgREST/PostgreSQL error phrase", pattern: /violates|constraint|relation "|pg_|plpgsql/i },
  { name: "a Vault reference", pattern: /vault\.|decrypted_secret|secret_id/i },
];

/** True when `text` contains nothing from `FORBIDDEN_IN_RESPONSES`. */
export function isSanitized(text: string): { ok: boolean; found: string[] } {
  const found = FORBIDDEN_IN_RESPONSES.filter(({ pattern }) =>
    pattern.test(text),
  ).map(({ name }) => name);
  return { ok: found.length === 0, found };
}
