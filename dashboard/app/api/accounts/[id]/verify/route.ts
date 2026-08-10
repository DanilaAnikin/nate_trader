import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { maskAccountNumber } from "@/lib/accounts/mask";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ALPACA_BASE: Record<string, string> = {
  paper: "https://paper-api.alpaca.markets/v2",
  live: "https://api.alpaca.markets/v2",
};

/**
 * POST /api/accounts/[id]/verify — re-check the stored credentials against
 * Alpaca and persist the resulting connection status. Never returns key
 * material.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // RLS scopes this select to the caller's own accounts.
  const { data: account } = await supa
    .from("accounts")
    .select("id,mode")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!account) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const svc = getSupabaseService();
  const { data: cred, error: credErr } = await svc.rpc("get_account_credentials", {
    acct: id,
  });
  if (credErr || !cred || cred.length === 0) {
    return NextResponse.json(
      { error: "no stored credentials" },
      { status: 409 },
    );
  }

  const base = ALPACA_BASE[account.mode];
  let res: Response;
  try {
    res = await fetch(`${base}/account`, {
      headers: {
        "APCA-API-KEY-ID": cred[0].api_key,
        "APCA-API-SECRET-KEY": cred[0].api_secret,
      },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "could not reach Alpaca" },
      { status: 502 },
    );
  }

  if (res.status === 401 || res.status === 403) {
    await svc.from("accounts").update({ status: "auth_failed" }).eq("id", id);
    return NextResponse.json({ ok: false, status: "auth_failed" });
  }
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, error: `Alpaca HTTP ${res.status}` },
      { status: 502 },
    );
  }

  const body = (await res.json().catch(() => null)) as {
    account_number?: string;
  } | null;
  const accountNumber = body?.account_number ?? null;

  // The full number is stored server-side (the production binding compares it
  // against a freshly read one) but must never be returned to the browser.
  await svc
    .from("accounts")
    .update({
      status: "connected",
      last_verified_at: new Date().toISOString(),
      alpaca_account_number: accountNumber,
    })
    .eq("id", id);

  return NextResponse.json(
    {
      ok: true,
      status: "connected",
      brokerAccountMask: maskAccountNumber(accountNumber),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
