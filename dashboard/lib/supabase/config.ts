/**
 * True when the Supabase environment variables are present. Used across the
 * app so screens degrade gracefully (legacy mode) before the environment is
 * wired up, instead of crashing.
 */
export const SUPABASE_CONFIGURED =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
