import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import {
  ACCOUNT_LIVE_SCHEMA_VERSION,
  ACCOUNT_LIVE_SOURCE,
  normalizeAlpacaPosition,
  type AccountLiveErrorCode,
} from "@/lib/account-live";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

const ALPACA_BASE: Record<string, string> = {
  paper: "https://paper-api.alpaca.markets/v2",
  live: "https://api.alpaca.markets/v2",
};

function apiError(code: AccountLiveErrorCode, error: string, status: number) {
  return NextResponse.json(
    { code, error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * GET /api/accounts/[id]/live — live Alpaca account + positions for one
 * account. The account-scoped, multi-account replacement for /api/live.
 * Credentials are decrypted server-side and never appear in the response.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) {
    return apiError("UNAUTHENTICATED", "Authentication is required.", 401);
  }

  // RLS scopes this to the caller's own accounts.
  const { data: account } = await supa
    .from("accounts")
    .select("id,nickname,mode")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!account) {
    return apiError("ACCOUNT_NOT_FOUND", "Account not found.", 404);
  }

  const svc = getSupabaseService();
  const { data: cred, error: credErr } = await svc.rpc("get_account_credentials", {
    acct: id,
  });
  if (credErr || !cred || cred.length === 0) {
    return apiError(
      "CREDENTIALS_MISSING",
      "This account has no stored Alpaca credentials.",
      409,
    );
  }

  const base = ALPACA_BASE[account.mode];
  if (!base) {
    return apiError("INVALID_RESPONSE", "Account broker mode is invalid.", 500);
  }
  const headers = {
    "APCA-API-KEY-ID": cred[0].api_key,
    "APCA-API-SECRET-KEY": cred[0].api_secret,
  };

  let accountRes: Response;
  let positionsRes: Response;
  try {
    const signal = AbortSignal.timeout(10_000);
    [accountRes, positionsRes] = await Promise.all([
      fetch(`${base}/account`, { headers, cache: "no-store", signal }),
      fetch(`${base}/positions`, { headers, cache: "no-store", signal }),
    ]);
  } catch {
    return apiError(
      "ALPACA_UNREACHABLE",
      "Could not reach Alpaca for the selected account.",
      502,
    );
  }

  if (accountRes.status === 401 || accountRes.status === 403) {
    await svc.from("accounts").update({ status: "auth_failed" }).eq("id", id);
    return apiError(
      "ALPACA_AUTH_FAILED",
      "Alpaca rejected this account's credentials.",
      502,
    );
  }
  if (!accountRes.ok || !positionsRes.ok) {
    return apiError(
      "ALPACA_API_ERROR",
      `Alpaca API error: account=${accountRes.status}, positions=${positionsRes.status}.`,
      502,
    );
  }

  const acc = await accountRes.json();
  const positions: Record<string, string>[] = await positionsRes.json();

  const equity = parseFloat(acc.equity ?? "0");
  const lastEquity = parseFloat(acc.last_equity ?? String(equity));
  const cash = parseFloat(acc.cash ?? "0");

  return NextResponse.json(
    {
      schemaVersion: ACCOUNT_LIVE_SCHEMA_VERSION,
      source: ACCOUNT_LIVE_SOURCE,
      accountId: id,
      nickname: account.nickname,
      mode: account.mode,
      timestamp: new Date().toISOString(),
      account: {
        equity,
        cash,
        cash_pct: equity > 0 ? (cash / equity) * 100 : 0,
        daily_pnl: equity - lastEquity,
        daily_pnl_pct:
          lastEquity > 0 ? ((equity - lastEquity) / lastEquity) * 100 : 0,
        num_positions: positions.length,
      },
      positions: positions.map(normalizeAlpacaPosition),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
