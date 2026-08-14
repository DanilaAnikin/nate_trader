/**
 * True when the Supabase environment variables are present. Used across the
 * app so screens degrade gracefully (legacy mode) before the environment is
 * wired up, instead of crashing.
 */
export const SUPABASE_CONFIGURED =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Legacy repository snapshots require an explicit opt-in outside production. */
export const LEGACY_DASHBOARD_ALLOWED =
  process.env.ALLOW_LEGACY_DASHBOARD === "true";

/**
 * Server-side Supabase origin.
 *
 * The browser talks to the public hostname and is allowed to reach GoTrue Auth
 * there and nothing else — the edge denies every other path. Everything that
 * runs on the server (SSR, the proxy, service-role work) must instead reach
 * Kong over the internal Docker network, so dashboard data traffic never
 * depends on the public data plane being open.
 *
 * This is runtime-only on purpose. It must never be a Docker build argument
 * and never a NEXT_PUBLIC_* variable, or it would be inlined into the client
 * bundle and published to every visitor.
 *
 * IMPORTANT — do not "simplify" this to the short alias `http://kong:8000`.
 * Six tenants' Kong containers share the dokploy-network and every one of them
 * claims the alias `kong`; Docker DNS round-robins between them, so the short
 * name resolves to a different tenant's gateway on different lookups. Measured
 * 2026-08-13: `kong` returned 10.0.1.183 / .186 / .235 from this container,
 * while natetrader's own gateway is 10.0.1.221. Use the unique container name.
 */
export function getSupabaseServerUrl(): string {
  const url = process.env.SUPABASE_SERVER_URL;
  if (!url) {
    // Fail closed. A dashboard that silently fell back to the public origin
    // would keep working while quietly defeating the containment it exists for.
    throw new Error("SUPABASE_SERVER_URL is not set");
  }
  return url;
}

/**
 * The Supabase auth cookie name, pinned explicitly.
 *
 * supabase-js derives its storage key from the FIRST DNS LABEL of whatever URL
 * the client was constructed with: `sb-${hostname.split(".")[0]}-auth-token`.
 * That is fine while every client shares one URL, and catastrophic the moment
 * they do not: with the browser on https://ntapi.anikin.cz and the server on
 * http://natetrader-supabase-kong:8000, the browser would write
 * `sb-ntapi-auth-token` while SSR and the proxy looked for
 * `sb-natetrader-supabase-kong-auth-token`, find no session, and redirect every
 * signed-in user to /login. Nothing in the app source names a cookie, so that
 * breakage would be invisible in review.
 *
 * Pinning one name across browser, server and proxy keeps existing sessions
 * valid across the hostname split. Chunked cookies are unaffected: @supabase/ssr
 * appends `.0`, `.1`, … to whatever base name it is given.
 */
export function getAuthCookieName(): string {
  const explicit = process.env.NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME;
  if (explicit) return explicit;

  // Default to the name the browser already uses today, derived the same way
  // supabase-js derives it, from the PUBLIC url — never the internal one.
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!publicUrl) {
    throw new Error(
      "Cannot determine the auth cookie name: NEXT_PUBLIC_SUPABASE_URL is not set",
    );
  }
  return `sb-${new URL(publicUrl).hostname.split(".")[0]}-auth-token`;
}
