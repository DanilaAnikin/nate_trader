import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { deleteAccount, rotateKeys, updateAccount } from "@/lib/accounts/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function statusFor(reason: string): number {
  if (reason === "not_found") return 404;
  if (reason === "invalid_keys" || reason === "invalid_input" || reason === "no_credentials")
    return 400;
  if (reason === "network" || reason === "alpaca_error") return 502;
  return 500;
}

/**
 * PATCH /api/accounts/[id]
 *  - { apiKey, apiSecret }                 → rotate credentials
 *  - { nickname?, color?, is_active? }      → update metadata
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
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

  try {
    const result =
      typeof body.apiKey === "string" || typeof body.apiSecret === "string"
        ? await rotateKeys(
            user.id,
            id,
            String(body.apiKey ?? ""),
            String(body.apiSecret ?? ""),
          )
        : await updateAccount(user.id, id, {
            nickname: typeof body.nickname === "string" ? body.nickname : undefined,
            color: typeof body.color === "string" ? body.color : undefined,
            is_active:
              typeof body.is_active === "boolean" ? body.is_active : undefined,
          });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        { status: statusFor(result.reason) },
      );
    }
    return NextResponse.json({ account: result.account });
  } catch {
    return NextResponse.json({ error: "account update failed" }, { status: 500 });
  }
}

/** DELETE /api/accounts/[id]?purgeHistory=true */
export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const purgeHistory =
    new URL(req.url).searchParams.get("purgeHistory") === "true";

  try {
    const result = await deleteAccount(user.id, id, { purgeHistory });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        { status: statusFor(result.reason) },
      );
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "account deletion failed" }, { status: 500 });
  }
}
