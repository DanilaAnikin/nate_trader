import "server-only";
import { cookies } from "next/headers";
import { getSupabaseServer } from "./supabase/server";
import { toSafe, type SafeAccount } from "./accounts/service";

export const SELECTED_ACCOUNT_COOKIE = "nt_account";

/** Every non-deleted account owned by the signed-in user (RLS-scoped). */
export async function getUserAccounts(): Promise<SafeAccount[]> {
  try {
    const supa = await getSupabaseServer();
    const { data } = await supa
      .from("accounts")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    return (data ?? []).map(toSafe);
  } catch {
    // Supabase unreachable (e.g. paused project). Treat as "no accounts" so
    // the dashboard renders its GitHub-sourced data instead of 504ing.
    return [];
  }
}

export type AccountSelection = {
  accounts: SafeAccount[];
  selected: SafeAccount | null;
};

/**
 * Resolve which account the dashboard should show, in order of preference:
 * the `nt_account` cookie → `profiles.default_account_id` → first active
 * account. Only the user's own accounts are ever candidates, so the cookie
 * value is validated simply by being looked up in that list.
 */
export async function getSelectedAccount(): Promise<AccountSelection> {
  const accounts = await getUserAccounts();
  if (accounts.length === 0) return { accounts, selected: null };

  const cookieStore = await cookies();
  const cookieId = cookieStore.get(SELECTED_ACCOUNT_COOKIE)?.value;

  let selected = cookieId
    ? (accounts.find((a) => a.id === cookieId) ?? null)
    : null;

  if (!selected) {
    try {
      const supa = await getSupabaseServer();
      const {
        data: { user },
      } = await supa.auth.getUser();
      if (user) {
        const { data: profile } = await supa
          .from("profiles")
          .select("default_account_id")
          .eq("id", user.id)
          .single();
        if (profile?.default_account_id) {
          selected =
            accounts.find((a) => a.id === profile.default_account_id) ?? null;
        }
      }
    } catch {
      // Supabase blip while resolving the default account — fall through to
      // the first active account below rather than failing the request.
    }
  }

  if (!selected) {
    selected = accounts.find((a) => a.is_active) ?? accounts[0];
  }
  return { accounts, selected };
}
