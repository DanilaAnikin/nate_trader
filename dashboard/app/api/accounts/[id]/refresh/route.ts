import { NextResponse } from "next/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { getSessionUser, loadOwnedAccount } from "@/lib/accounts/session";
import { refreshBrokerDatasets } from "@/lib/accounts/broker-refresh";
import { maintenanceBlock } from "@/lib/maintenance";
import { incident } from "@/lib/incident";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Fixed prose per refused outcome.
 *
 * The outcome name is a published contract the UI branches on, so it stays in
 * the response. What may not stay is anything derived from the failure itself
 * — each string here is written in advance and interpolates nothing.
 */
const REFRESH_OUTCOME_MESSAGE: Record<string, string> = {
  RECONCILIATION_CONFLICT:
    "Another refresh of this account is in flight. The stored data is unchanged.",
  CREDENTIALS_ROTATED:
    "The account credentials changed while this refresh was running. The stored data is unchanged.",
  STALE_GENERATION:
    "A newer refresh has already published. The stored data is unchanged.",
  BROKER_UNREACHABLE:
    "Alpaca could not be reached. The stored data is unchanged.",
  NON_CASH_EXTERNAL_TRANSFER:
    "This account has an external securities transfer, so no return can be attributed across it. The stored data is unchanged.",
};

const GENERIC_REFUSAL = "The refresh was refused. The stored data is unchanged.";

/**
 * POST /api/accounts/[id]/refresh — republish both broker mirrors.
 *
 * This is the *only* path that writes `equity_snapshots` or `cash_flows`.
 * `GET /equity` and `GET /performance` used to do it as a side effect, so a
 * page that polled wrote on every poll, two open tabs raced each other, and
 * the write carried no record of who asked for it.
 *
 * The whole operation is one transaction in the database: both datasets are
 * fetched and fully validated first, then published under a reservation bound
 * to the account, owner, mode, broker account number and credential version it
 * was issued against. Any refusal leaves the mirrors byte-for-byte unchanged —
 * `mirrorMutated` is part of the response so a caller can say so honestly.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const frozen = maintenanceBlock();
  if (frozen) return frozen;

  const { id } = await params;
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { code: "UNAUTHENTICATED", error: "Authentication is required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const account = await loadOwnedAccount(user.id, id);
  if (!account) {
    return NextResponse.json(
      { code: "ACCOUNT_NOT_FOUND", error: "Account not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const svc = getSupabaseService();
  const result = await refreshBrokerDatasets(
    svc,
    id,
    account.owner_id,
    account.mode,
  );

  if (!result.ok) {
    // A refused refresh is a named outcome, not a server error: the mirrors
    // are intact and the caller can decide whether to retry. The *outcome* is
    // a closed contract and stays. `detail` does not: it is written for a
    // server log and carries the RPC arguments, which on this path include
    // Vault ids and the broker account number. It goes to the log, and an
    // incident id comes back in its place.
    const status = result.reason === "RECONCILIATION_CONFLICT" ? 409 : 502;
    const logged = incident("INTERNAL", result.detail, {
      route: "POST /api/accounts/[id]/refresh",
      outcome: result.reason,
    });
    return NextResponse.json(
      {
        code: result.reason,
        error: REFRESH_OUTCOME_MESSAGE[result.reason] ?? GENERIC_REFUSAL,
        incidentId: logged.incidentId,
        // The two facts a caller must have to decide whether a retry is safe.
        // Neither is derived from the failure text.
        mirrorMutated: result.mirrorMutated,
        reservationTaken: result.reservationTaken,
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      accountId: id,
      generation: result.generation,
      equityWritten: result.equityWritten,
      flowsWritten: result.flowsWritten,
      // Always zero. A refresh has no code path that removes a row; see
      // `retract_equity_snapshot` / `retract_cash_flow` for the audited way.
      equityRemoved: result.equityRemoved,
      flowsRemoved: result.flowsRemoved,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
