import { NextResponse } from "next/server";
import { getSupabaseService } from "@/lib/supabase/service";
import {
  getSessionUser,
  loadOwnedAccount,
} from "@/lib/accounts/session";
import { fetchBrokerSnapshot, loadCredentials } from "@/lib/status/broker";
import type { BrokerInfo } from "@/lib/status/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const BROKER_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const BROKER_SNAPSHOT_SOURCE = "alpaca-account-snapshot" as const;

type Ctx = { params: Promise<{ id: string }> };

export interface BrokerSnapshotPayload {
  readonly schemaVersion: typeof BROKER_SNAPSHOT_SCHEMA_VERSION;
  readonly source: typeof BROKER_SNAPSHOT_SOURCE;
  readonly accountId: string;
  readonly nickname: string;
  readonly mode: "paper" | "live";
  readonly fetchedAt: string;
  readonly broker: BrokerInfo;
}

/**
 * GET /api/accounts/[id]/live — a fresh, read-only broker snapshot for one
 * ownership-checked account.
 *
 * Used by the accounts screen, which needs per-account equity without paying
 * for the full strategy read model. Credentials are decrypted server-side and
 * never appear in the response.
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

  const account = await loadOwnedAccount(user.id, id);
  if (!account) {
    return NextResponse.json(
      { code: "ACCOUNT_NOT_FOUND", error: "Account not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const svc = getSupabaseService();
  const credentials = await loadCredentials(svc, id);
  if (!credentials) {
    return NextResponse.json(
      {
        code: "CREDENTIALS_MISSING",
        error: "This account has no stored Alpaca credentials.",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await fetchBrokerSnapshot(credentials, account.mode);
  if (!result.ok) {
    if (result.code === "ALPACA_AUTH_FAILED") {
      await svc.from("accounts").update({ status: "auth_failed" }).eq("id", id);
    }
    return NextResponse.json(
      { code: result.code, error: result.detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const payload: BrokerSnapshotPayload = {
    schemaVersion: BROKER_SNAPSHOT_SCHEMA_VERSION,
    source: BROKER_SNAPSHOT_SOURCE,
    accountId: id,
    nickname: account.nickname,
    mode: account.mode,
    fetchedAt: result.fetchedAt,
    broker: result.snapshot,
  };
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
