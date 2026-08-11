import { NextResponse } from "next/server";
import { maintenanceBlock } from "@/lib/maintenance";
import { incident, type IncidentCode } from "@/lib/incident";
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

/**
 * How each internal failure reason surfaces to the browser.
 *
 * The mapping is explicit and total: a reason with no entry becomes
 * `INTERNAL`, which is the safe direction. Nothing derived from the failure
 * text reaches the client.
 */
const CLIENT_OUTCOME: Record<string, { code: IncidentCode; status: number }> = {
  invalid_input: { code: "INVALID_INPUT", status: 400 },
  invalid_keys: { code: "INVALID_KEYS", status: 400 },
  network: { code: "BROKER_UNREACHABLE", status: 502 },
  alpaca_error: { code: "BROKER_ERROR", status: 502 },
  indeterminate: { code: "INDETERMINATE", status: 503 },
  db_error: { code: "INTERNAL", status: 500 },
};

/** POST /api/accounts → validate keys and create the account in one transaction. */
export async function POST(req: Request) {
  const frozen = maintenanceBlock();
  if (frozen) return frozen;

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
    // `operationId` is part of the request schema, not something the server
    // makes up: the thing being made idempotent is this HTTP request, and a
    // server-generated id is fresh on every retry — exactly when it matters.
    const result = await createAccount(user.id, {
      nickname: String(body.nickname ?? ""),
      mode: body.mode as AccountMode,
      apiKey: String(body.apiKey ?? ""),
      apiSecret: String(body.apiSecret ?? ""),
      color: typeof body.color === "string" ? body.color : undefined,
      operationId: String(body.operationId ?? ""),
    });
    if (!result.ok) {
      // The message is written for a server log and says operator things: the
      // constraint that fired, the relation, and — because these RPCs take
      // them as arguments — Vault UUIDs, the operation id and the broker
      // account number. It is logged with an incident id and never returned.
      const { code, status } = CLIENT_OUTCOME[result.reason] ?? {
        code: "INTERNAL" as const,
        status: 500,
      };
      return NextResponse.json(incident(code, result.message, { route: "POST /api/accounts" }), {
        status,
      });
    }
    return NextResponse.json({ account: result.account }, { status: 201 });
  } catch (caught) {
    return NextResponse.json(
      incident(
        "INTERNAL",
        caught instanceof Error ? caught.message : "unknown error",
        { route: "POST /api/accounts" },
      ),
      { status: 500 },
    );
  }
}
