import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { createAccount, listAccounts } from "@/lib/accounts/service";
import type { AccountMode } from "@/lib/accounts/credentials";

export const dynamic = "force-dynamic";

/** GET /api/accounts → the signed-in user's accounts (no key material). */
export async function GET() {
  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const accounts = await listAccounts(user.id);
    return NextResponse.json({ accounts });
  } catch {
    return NextResponse.json({ error: "could not list accounts" }, { status: 500 });
  }
}

/** POST /api/accounts → validate keys, store in Vault, create the account. */
export async function POST(req: Request) {
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
    const result = await createAccount(user.id, {
      nickname: String(body.nickname ?? ""),
      mode: body.mode as AccountMode,
      apiKey: String(body.apiKey ?? ""),
      apiSecret: String(body.apiSecret ?? ""),
      color: typeof body.color === "string" ? body.color : undefined,
    });
    if (!result.ok) {
      const status =
        result.reason === "invalid_keys" || result.reason === "invalid_input"
          ? 400
          : result.reason === "network" || result.reason === "alpaca_error"
            ? 502
            : 500;
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        { status },
      );
    }
    return NextResponse.json({ account: result.account }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "account creation failed" }, { status: 500 });
  }
}
