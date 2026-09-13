import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { maintenanceBlock } from "@/lib/maintenance";

export const dynamic = "force-dynamic";

const READABLE = "display_name, default_account_id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function sessionUser() {
  const supabase = await getSupabaseServer();
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
}

/** Public Supabase accepts Auth only; profile reads stay on the internal data path. */
export async function GET() {
  try {
    const user = await sessionUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    const { data, error } = await getSupabaseService()
      .from("profiles").select(READABLE).eq("id", user.id).maybeSingle();
    if (error) return json({ error: "Could not read profile." }, 503);
    return json({ profile: {
      display_name: data?.display_name ?? null,
      default_account_id: data?.default_account_id ?? null,
    } });
  } catch {
    return json({ error: "Could not read profile." }, 503);
  }
}

/** Only existing profile preferences are writable; account lifecycle is separate. */
export async function PATCH(request: Request) {
  const frozen = maintenanceBlock();
  if (frozen) return frozen;
  try {
    const user = await sessionUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    let body: unknown;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid profile update." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Invalid profile update." }, 400);
    }
    const fields = Object.entries(body);
    const patch: { display_name?: string | null; default_account_id?: string | null } = {};
    if (!fields.length) return json({ error: "Invalid profile update." }, 400);
    for (const [key, value] of fields) {
      if (key === "display_name" && (value === null || typeof value === "string")) {
        if (typeof value === "string" && value.length > 200) {
          return json({ error: "Display name is too long." }, 400);
        }
        patch.display_name = typeof value === "string" ? value.trim() || null : null;
      } else if (key === "default_account_id" &&
        (value === null || (typeof value === "string" && UUID.test(value)))) {
        patch.default_account_id = value;
      } else return json({ error: "Invalid profile update." }, 400);
    }

    const service = getSupabaseService();
    if (patch.default_account_id) {
      const { data, error } = await service.from("accounts").select("id")
        .eq("id", patch.default_account_id).eq("owner_id", user.id)
        .is("deleted_at", null).maybeSingle();
      if (error) return json({ error: "Could not verify default account." }, 503);
      if (!data) return json({ error: "Invalid default account." }, 400);
    }
    const { data, error } = await service.from("profiles").update(patch)
      .eq("id", user.id).select(READABLE).maybeSingle();
    if (error || !data) return json({ error: "Could not save profile." }, 503);
    return json({ profile: {
      display_name: data.display_name,
      default_account_id: data.default_account_id,
    } });
  } catch {
    return json({ error: "Could not save profile." }, 503);
  }
}
