import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
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
  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { code: "UNAUTHENTICATED", error: "Authentication is required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // RLS scopes this to the caller's own accounts. `owner_id` is read here (and
  // re-checked below) so production authorization can never rest on anything
  // the browser supplied.
  const { data: account } = await supa
    .from("accounts")
    .select("id,nickname,mode,owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!account || account.owner_id !== user.id) {
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
