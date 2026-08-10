import { NextResponse } from "next/server";
import { getSupabaseService } from "@/lib/supabase/service";
import {
  getSessionUser,
  loadOwnedAccount,
} from "@/lib/accounts/session";
import { fetchBrokerSnapshot, loadCredentials } from "@/lib/status/broker";
import { buildStrategyStatus } from "@/lib/status/read-model";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/accounts/[id]/status — the single, account-scoped V11 read model.
 *
 * Everything the UI shows comes from here: broker snapshot, approved release,
 * private runtime artifact, canonical validation, scheduler health and
 * research evidence, each with its own source, scope, timestamp and freshness.
 *
 * This endpoint is strictly read-only. It cannot place, replace or cancel a
 * broker order, and it never returns credentials, Vault identifiers, full
 * broker account numbers, raw artifacts or order identifiers.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { code: "UNAUTHENTICATED", error: "Authentication is required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Service-role read with an explicit ownership check in code. `owner_id`
  // feeds the production authorization, so it must never come from anything
  // the browser supplied nor rest solely on an RLS policy.
  const account = await loadOwnedAccount(user.id, id);
  if (!account) {
    return NextResponse.json(
      { code: "ACCOUNT_NOT_FOUND", error: "Account not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const svc = getSupabaseService();
  const credentials = await loadCredentials(svc, id);
  const broker = credentials
    ? await fetchBrokerSnapshot(credentials, account.mode)
    : ({
        ok: false,
        code: "CREDENTIALS_MISSING",
        detail: "This account has no stored Alpaca credentials.",
      } as const);

  if (!broker.ok && broker.code === "ALPACA_AUTH_FAILED") {
    await svc.from("accounts").update({ status: "auth_failed" }).eq("id", id);
  }

  const payload = await buildStrategyStatus({
    viewer: { userId: user.id },
    account: {
      id: account.id,
      nickname: account.nickname,
      mode: account.mode,
      ownerId: account.owner_id,
    },
    broker,
  });

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
