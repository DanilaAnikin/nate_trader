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
