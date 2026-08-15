/**
 * The frozen containment bridge's single write refusal.
 *
 * WHY THIS IS A CONSTANT, AND NOT A FLAG
 * --------------------------------------
 * The bridge previously refused writes because `DASHBOARD_MAINTENANCE_MODE`
 * was set. That is a deployment property, not a property of the artifact: the
 * same image with the flag unset, empty, or absent would happily attempt a
 * write against a database whose schema it was never validated for, and whose
 * account-lifecycle wrappers migration 0022 has deliberately tombstoned.
 *
 * This image is a containment artifact. Its writes are off in the CODE. There
 * is no environment variable, no bypass user and no sidecar mode that turns
 * them on, because there is no branch to take: every mutating handler returns
 * this constant and does nothing else.
 *
 * What "does nothing else" means precisely, because each clause is separately
 * asserted by the containment gate:
 *
 *   - the request body is never read
 *   - the caller is never authenticated
 *   - no Supabase client is constructed
 *   - no PostgREST call, no RPC, no database call
 *   - no Alpaca/broker call
 *   - no mutation service or credentials helper is even IMPORTED, so the
 *     tombstoned vault_* wrappers are not in this file's transitive closure
 *
 * The proxy keeps its own pre-authentication refusal. That is deliberate
 * redundancy: two independent layers, either of which is sufficient, so a
 * regression in one is caught by the gate rather than by production.
 */

/** Stable, non-secret identity of this artifact. Surfaced by /api/health. */
export const ARTIFACT_ROLE = "frozen-containment-bridge" as const;
export const WRITES_ENABLED = false as const;
/**
 * This image is NOT a general latest-schema-compatible dashboard. It is
 * deliberately incompatible with the unfrozen lifecycle: it cannot rotate
 * credentials, create or delete accounts. Anything consuming this artifact
 * must be able to see that, so it can never be mistaken for the candidate.
 */
export const UNFROZEN_COMPATIBLE = false as const;
export const CREDENTIAL_MUTATION_COMPATIBLE = false as const;

/** The one body every refused mutation returns. */
export const FROZEN_BODY = {
  error: "frozen",
  reason: "FROZEN_CONTAINMENT_BRIDGE",
  message:
    "This deployment is a frozen containment bridge. Write operations are " +
    "disabled in the image itself and cannot be enabled by configuration.",
  artifact_role: ARTIFACT_ROLE,
  writes_enabled: WRITES_ENABLED,
} as const;

/**
 * Every mutating handler returns exactly this.
 *
 * Constructed fresh per call rather than shared, because a single frozen
 * `Response` object cannot be returned twice — its body stream is consumed on
 * first use, and the second caller would get an empty body. The *content* is
 * constant; the object is not shared.
 */
export function frozenResponse(): Response {
  return new Response(JSON.stringify(FROZEN_BODY), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      // Advertised so an operator reading a raw response can tell a containment
      // refusal from an ordinary outage.
      "X-Artifact-Role": ARTIFACT_ROLE,
      "X-Writes-Enabled": "false",
    },
  });
}
