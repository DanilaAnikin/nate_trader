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
 * **Side-effect free.** It reads the broker, the GitHub artifacts and the
 * database, and writes nothing to any of them.
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

  // No write here, deliberately. This handler used to set `status` to
  // `auth_failed` when Alpaca rejected the credentials, which made a GET
  // mutate the account — unaudited, from a path with no CSRF protection and
  // no user intent, and reachable by any page that happened to poll. The
  // broker rejection is reported in the payload; recording it is the job of
  // `POST /api/accounts/[id]/verify`, which does it atomically and audits it.

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
