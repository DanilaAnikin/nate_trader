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

/** Runtime-only origin for SSR and service-role requests behind Auth-only ingress. */
export function getSupabaseServerUrl(): string {
  const raw = process.env.SUPABASE_SERVER_URL;
  if (!raw) throw new Error("SUPABASE_SERVER_URL is not set");
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash ||
    url.pathname !== "/" || url.hostname === "kong"
  ) {
    throw new Error("SUPABASE_SERVER_URL must be an unambiguous HTTP(S) origin");
  }
  return url.origin;
}

/** Keep the browser's existing session name when server and browser hosts differ. */
export function getAuthCookieName(): string {
  const explicit = process.env.NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME;
  if (explicit) return explicit;
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!publicUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return `sb-${new URL(publicUrl).hostname.split(".")[0]}-auth-token`;
}
