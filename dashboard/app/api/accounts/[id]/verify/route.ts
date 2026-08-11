import { NextResponse } from "next/server";
import { maintenanceBlock } from "@/lib/maintenance";
import { incident } from "@/lib/incident";
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

  // Begin the verification: one transaction takes the account row, reads the
  // credentials, and issues a single-use token recording the mode, the broker
  // account number and the credential version they belong to.
  //
  // The previous shape read the version with a separate query and passed it as
  // an *expectation*; a caller that could not read it passed null, which
  // disabled the check entirely. There is no null path now — if the snapshot
  // cannot be taken, the broker is never asked.
  const { data: snapshot, error: beginError } = await svc.rpc(
    "begin_account_verification",
    { p_account: id, p_owner: account.owner_id },
  );
  const issued =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)
      : null;
  const token = issued?.token;
  const apiKey = issued?.api_key;
  const apiSecret = issued?.api_secret;
  const mode = issued?.mode;

  if (
    beginError ||
    typeof token !== "string" ||
    typeof apiKey !== "string" ||
    typeof apiSecret !== "string" ||
    (mode !== "paper" && mode !== "live")
  ) {
    return NextResponse.json(
      incident(
        "CONFLICT",
        `verification could not be started: ${beginError?.message ?? "incomplete snapshot"}`,
        { route: "POST /api/accounts/[id]/verify", accountId: id },
      ),
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  // The broker is asked with exactly the snapshot the token describes — its
  // mode included, rather than a mode the caller was holding.
  const base = ALPACA_BASE[mode];
  let res: Response;
  try {
    res = await fetch(`${base}/account`, {
      headers: {
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": apiSecret,
      },
      cache: "no-store",
    });
  } catch (caught) {
    return NextResponse.json(
      incident(
        "BROKER_UNREACHABLE",
        caught instanceof Error ? caught.message : "unknown network error",
        { route: "POST /api/accounts/[id]/verify", accountId: id },
      ),
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const finish = async (
    status: "connected" | "auth_failed",
    accountNumber: string | null,
  ) =>
    svc.rpc("finish_account_verification", {
      p_token: token,
      p_status: status,
      p_account_number: accountNumber,
    });

  if (res.status === 401 || res.status === 403) {
    const { error } = await finish("auth_failed", null);
    if (error) {
      return NextResponse.json(
        incident("CONFLICT", `auth_failed could not be recorded: ${error.message}`, {
          route: "POST /api/accounts/[id]/verify",
          accountId: id,
        }),
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ok: false, status: "auth_failed" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!res.ok) {
    return NextResponse.json(
      incident("BROKER_ERROR", `Alpaca HTTP ${res.status}`, {
        route: "POST /api/accounts/[id]/verify",
        accountId: id,
      }),
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const body = (await res.json().catch(() => null)) as {
    account_number?: string;
  } | null;
  const accountNumber = body?.account_number ?? null;
  if (!accountNumber) {
    return NextResponse.json(
      incident("BROKER_ERROR", "Alpaca returned no account number", {
        route: "POST /api/accounts/[id]/verify",
        accountId: id,
      }),
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  // `finish` requires the token and refuses if the credential version, the
  // mode or the binding moved while Alpaca was answering. A rotation that
  // landed mid-call makes this fail rather than certify the new keys on the
  // strength of a test of the old.
  const { error: finishError } = await finish("connected", accountNumber);
  if (finishError) {
    return NextResponse.json(
      incident("CONFLICT", `verification could not be recorded: ${finishError.message}`, {
        route: "POST /api/accounts/[id]/verify",
        accountId: id,
      }),
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      status: "connected",
      // Masked, always: the full number is the production binding.
      brokerAccountMask: maskAccountNumber(accountNumber),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
