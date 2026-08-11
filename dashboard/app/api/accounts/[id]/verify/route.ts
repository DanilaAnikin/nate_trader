import { NextResponse } from "next/server";
import { maintenanceBlock } from "@/lib/maintenance";
import { getSupabaseService } from "@/lib/supabase/service";
import {
  getSessionUser,
  loadOwnedAccount,
} from "@/lib/accounts/session";
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
  const frozen = maintenanceBlock();
  if (frozen) return frozen;

  const { id } = await params;
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const account = await loadOwnedAccount(user.id, id);
  if (!account) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const svc = getSupabaseService();
  // The credential version the keys about to be tested belong to. Alpaca's
  // answer describes *these* keys; if they are rotated away while it is being
  // asked, writing `connected` from that answer would mark the new keys
  // verified on the strength of a test of the old ones.
  const { data: versionRow } = await svc
    .from("accounts")
    .select("credential_version")
    .eq("id", id)
    .maybeSingle();
  const expectedVersion =
    typeof versionRow?.credential_version === "number"
      ? versionRow.credential_version
      : null;

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
    // One transaction, one audit entry. A bare `.update()` recorded a status
    // change with no record of who made it or why, and the same write was
    // reachable from two GET handlers.
    const { error } = await svc.rpc("record_account_verification", {
      p_account: id,
      p_owner: account.owner_id,
      p_status: "auth_failed",
      p_expected_version: expectedVersion,
    });
    if (error) {
      // The credentials really are rejected, and the row still says otherwise.
      return NextResponse.json(
        {
          ok: false,
          error: `Alpaca rejected these credentials, but the account status could not be recorded: ${error.message}`,
        },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ok: false, status: "auth_failed" },
      { headers: { "Cache-Control": "no-store" } },
    );
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
  if (!accountNumber) {
    // The binding compares this number; verifying without one proves nothing.
    return NextResponse.json(
      { ok: false, error: "Alpaca returned no account number" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  // The full number is stored server-side (the production binding compares it
  // against a freshly read one) but must never be returned to the browser.
  // `record_account_verification` writes the status, the timestamp and the
  // audit entry in one transaction. It may only *confirm* the broker account
  // number, never change it: the number is fixed at creation, because the
  // production binding compares against it and one equity curve cannot
  // describe two broker accounts.
  //
  // `p_expected_version` binds the write to the keys that were actually
  // tested. A rotation that landed while Alpaca was being asked makes this
  // refuse rather than certify the new keys with the old keys' result.
  const { error: updateError } = await svc.rpc("record_account_verification", {
    p_account: id,
    p_owner: account.owner_id,
    p_status: "connected",
    p_account_number: accountNumber,
    p_expected_version: expectedVersion,
  });
  if (updateError) {
    // Reporting "connected" here would claim a binding that was never stored:
    // the next production authorization compares against the *old* number.
    return NextResponse.json(
      {
        ok: false,
        error: `The credentials are valid, but the verification could not be recorded: ${updateError.message}`,
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      status: "connected",
      brokerAccountMask: maskAccountNumber(accountNumber),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
