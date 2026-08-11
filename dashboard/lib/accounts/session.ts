import "server-only";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import type { Database } from "@/lib/database.types";

/**
 * The one way a route obtains an account row.
 *
 * Migration 0011 removes every client privilege on `accounts`, so the
 * cookie-bound (`authenticated`) client can no longer read it — and should not:
 * RLS was doing the ownership check implicitly, which meant an accidental
 * policy change silently widened every route at once.
 *
 * These helpers instead read with the service role and verify the session and
 * ownership *explicitly, in code*, so the check is visible at each call site
 * and cannot be loosened by a database policy edit. Soft-deleted accounts are
 * excluded everywhere.
 */

type AccountRow = Database["public"]["Tables"]["accounts"]["Row"];

export interface SessionUser {
  readonly id: string;
}

/** The signed-in user, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  return user ? { id: user.id } : null;
}

/**
 * Load one account **only** if the signed-in user owns it and it is not
 * soft-deleted. Returns null for "not found" and "not yours" alike, so a
 * caller cannot distinguish the two.
 */
export async function loadOwnedAccount(
  userId: string,
  accountId: string,
): Promise<AccountRow | null> {
  const svc = getSupabaseService();
  const { data, error } = await svc
    .from("accounts")
    .select("*")
    .eq("id", accountId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) return null;
  // Explicit ownership check in application code, not only in a policy.
  if (data.owner_id !== userId) return null;
  return data;
}

/** Every non-deleted account owned by the user, oldest first. */
export async function listOwnedAccounts(userId: string): Promise<AccountRow[]> {
  const svc = getSupabaseService();
  const { data, error } = await svc
    .from("accounts")
    .select("*")
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data.filter((row) => row.owner_id === userId);
}

/**
 * The signed-in user's id, or null — without the account lookup.
 *
 * The maintenance guard needs it *before* anything else runs, so that an
 * allowlisted operator on an isolated sidecar can be let through while
 * everyone else is refused. It must not itself write or throw.
 */
export async function sessionUserId(): Promise<string | null> {
  try {
    const user = await getSessionUser();
    return user?.id ?? null;
  } catch {
    return null;
  }
}
