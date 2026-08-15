import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { frozenResponse } from "@/lib/frozen";

export const dynamic = "force-dynamic";

/**
 * Same-origin profile boundary.
 *
 * The settings page used to reach `profiles` directly from the browser with
 * the anon key, which is why the public Supabase data plane had to stay
 * reachable at all. Moving those three calls here is what lets the edge deny
 * everything under /rest/v1 while Auth keeps working.
 *
 * Two rules make this a boundary rather than a proxy:
 *
 *   1. The row is chosen by the id on the *verified session*, never by an id
 *      in the request. A caller cannot name someone else's profile because
 *      there is nowhere to put the name.
 *   2. Writes go through the service-role client, so the grants that migration
 *      0012 gave `authenticated` on `profiles` can be revoked by a later
 *      migration without breaking this route. Until that migration lands the
 *      route already behaves as if the grants were gone.
 */

/** Exactly the columns a user may see about their own profile. */
const READABLE = "display_name, default_account_id" as const;

/**
 * Exactly the columns a user may write, and how each is normalised. A key
 * absent from this map is rejected rather than ignored: silently dropping an
 * unknown field is how a typo becomes "the save worked" in the UI.
 */
// The PATCH allowlist and its types are gone with the handler that used
// them. Keeping dead validation scaffolding beside a constant refusal
// invites someone to wire it back up.
/** GET /api/profile → the signed-in user's own profile fields. */
export async function GET() {
  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const svc = getSupabaseService();
  const { data, error } = await svc
    .from("profiles")
    .select(READABLE)
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "could not read profile" }, { status: 500 });
  }
  return NextResponse.json({
    profile: {
      display_name: data?.display_name ?? null,
      default_account_id: data?.default_account_id ?? null,
    },
  });
}

/**
 * Profile update is disabled in this artifact.
 *
 * This one never touched Vault or the account lifecycle — it writes
 * `display_name` and `default_account_id` on the caller's own `profiles` row,
 * both created by migration 0002 and therefore present on the pre-migration
 * schema. It is frozen anyway, because the containment property is "this image
 * performs no writes", not "this image performs only the writes we currently
 * believe are safe". A per-route judgement about which writes are harmless is
 * exactly the thing that erodes.
 *
 * The body is not read and the caller is not authenticated: the refusal is
 * unconditional, so there is nothing to decide.
 */
export async function PATCH(): Promise<Response> {
  return frozenResponse();
}
