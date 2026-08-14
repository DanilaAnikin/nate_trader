import { NextResponse } from "next/server";
import { maintenanceBlock } from "@/lib/maintenance";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";

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
const WRITABLE = {
  display_name: (v: unknown): string | null => {
    if (v === null) return null;
    if (typeof v !== "string") throw new Error("display_name must be a string");
    const t = v.trim();
    if (t.length > 120) throw new Error("display_name too long");
    return t.length ? t : null;
  },
  default_account_id: (v: unknown): string | null => {
    if (v === null || v === "") return null;
    if (typeof v !== "string") throw new Error("default_account_id must be a string");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
      throw new Error("default_account_id must be a uuid");
    }
    return v;
  },
} as const;

type Writable = keyof typeof WRITABLE;

/**
 * The update payload, typed as the exact columns rather than a loose record:
 * the generated Supabase types reject an index signature, and that rejection
 * is useful — it means a new writable key has to be added here deliberately.
 */
type ProfilePatch = { display_name?: string | null; default_account_id?: string | null };

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

/** PATCH /api/profile → update only the allowlisted fields, on your own row. */
export async function PATCH(req: Request) {
  const frozen = maintenanceBlock();
  if (frozen) return frozen;

  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: ProfilePatch = {};
  for (const key of Object.keys(body)) {
    if (!Object.prototype.hasOwnProperty.call(WRITABLE, key)) {
      return NextResponse.json({ error: `field not writable: ${key}` }, { status: 400 });
    }
    const k = key as Writable;
    try {
      patch[k] = WRITABLE[k](body[k]);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "invalid field" },
        { status: 400 },
      );
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no writable fields supplied" }, { status: 400 });
  }

  const svc = getSupabaseService();

  // Ownership: a default account must be one of *this user's* accounts that is
  // still live. Without this check the field is an arbitrary uuid write that
  // happens to be displayed back as the user's default.
  if (patch.default_account_id) {
    const { data: owned, error: ownErr } = await svc
      .from("accounts")
      .select("id")
      .eq("id", patch.default_account_id)
      .eq("owner_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (ownErr) {
      return NextResponse.json({ error: "could not verify account" }, { status: 500 });
    }
    if (!owned) {
      // Deliberately the same shape whether the account belongs to someone
      // else or does not exist: the response must not be an existence oracle.
      return NextResponse.json({ error: "unknown account" }, { status: 400 });
    }
  }

  const { error } = await svc.from("profiles").update(patch).eq("id", user.id);
  if (error) {
    return NextResponse.json({ error: "could not save profile" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
