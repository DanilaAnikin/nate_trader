import "server-only";
import {
  getAuthCookieName,
  getSupabaseServerUrl,
  SUPABASE_CONFIGURED,
} from "./config";

/** Configuration readiness only; does not make a network request. */
export function supabaseBackendConfigured(): boolean {
  if (!SUPABASE_CONFIGURED || !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return false;
  }
  try {
    getSupabaseServerUrl();
    getAuthCookieName();
    return true;
  } catch {
    return false;
  }
}
