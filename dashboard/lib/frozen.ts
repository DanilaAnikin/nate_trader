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
 * regression in one is caught by the gate rather than by production. Both
 * layers really are there — an audit found the proxy's matcher excluded any
 * path ending in an image extension, so `/api/accounts/x.png` had only one;
 * test/containment/proxy-matcher.mjs now asserts the proxy is invoked.
 *
 * WHAT THIS DOES NOT COVER, STATED PLAINLY
 * ----------------------------------------
 * "This image performs no writes" is a claim about THIS IMAGE, and the browser
 * can talk to Supabase without going through it. Two client components do:
 * `app/login/page.tsx` signs in, and `app/(app)/settings/page.tsx` changes a
 * password. Both go straight from the browser to GoTrue; neither request
 * touches this process, so no layer here can refuse them.
 *
 * That is intended rather than overlooked. The Auth surface stays open on
 * purpose — Stage 2's edge allows exactly /auth/v1 so that login keeps working
 * — and a password change mutates the identity provider's own record, not
 * application data. But an unqualified "no writes" would be true of the image
 * and false of the product, so the boundary is named here and enforced in
 * test/containment/client-mutations.test.ts: the browser may reach Auth and
 * nothing else. A client component that used `.from()` or `.rpc()` would sit
 * outside every control this artifact has, and that test fails on it.
 *
 * TWO MORE, FOUND BY AUDIT AND NAMED HERE BECAUSE THEY WERE NOT.
 *
 * (1) THE EDGE FREEZE IS API-SCOPED, SO SERVER ACTIONS ARE NOT EDGE-FROZEN.
 * `proxy.ts` refuses on `isApi && MUTATING_METHODS.has(method)`. A Next Server
 * Action is a POST to a PAGE path carrying a `Next-Action` header, so it runs
 * the proxy — the matcher covers page paths — but `isApi` is false and the
 * freeze block is skipped; only the auth check applies. Saying Server Actions
 * are "inside the containment surface" overstates it: they are inside the
 * MATCHER and inside the module-graph closure `reachability.mjs` walks, and
 * they are enumerated and classified by
 * test/containment/server-actions.test.ts. They are not inside the edge
 * refusal. That is a deliberate trade — freezing them would break sign-out,
 * which is itself a Server Action — and the three that exist are
 * `signOut` (GoTrue), `refreshAll` (revalidatePath) and `selectAccount` (a
 * cookie). None writes application data. The guard against a fourth one that
 * does is static, not runtime, so it is only as good as that classifier, which
 * is why its head-of-file window was closed.
 *
 * (2) THIS IMAGE DOES PERFORM ONE WRITE. `app/auth/actions.ts`'s `signOut()`
 * runs server-side and calls GoTrue, which deletes from `auth.sessions` and
 * `auth.refresh_tokens` in the same self-hosted Postgres. The carve-out above
 * is written as though the Auth exception were only the browser's; it is not.
 * The write is to the identity provider's own tables, never to application
 * data, and it is the same category the browser exception already permits —
 * but "this image performs no writes", unqualified, is false, and it is better
 * to say so here than to have it discovered.
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

/**
 * The one body every refused mutation returns.
 *
 * `Object.freeze` because `as const` is a TypeScript assertion and nothing
 * more: it constrains what the compiler will let you write, and disappears
 * entirely at runtime. An audit pointed out that any module in the image could
 * assign to these properties, after which `/api/health` would advertise
 * `writes_enabled: true` while the handlers went on returning 503 — the
 * artifact's self-description and its behaviour disagreeing, with the
 * description being the part operators read. `lib/v11-policy.ts` already
 * freezes its policy object for the same reason; this one should not have been
 * the exception.
 *
 * The 503 itself is a literal at the callsite and was never movable.
 */
export const FROZEN_BODY = Object.freeze({
  error: "frozen",
  reason: "FROZEN_CONTAINMENT_BRIDGE",
  message:
    "This deployment is a frozen containment bridge. Write operations are " +
    "disabled in the image itself and cannot be enabled by configuration.",
  artifact_role: ARTIFACT_ROLE,
  writes_enabled: WRITES_ENABLED,
} as const);

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
