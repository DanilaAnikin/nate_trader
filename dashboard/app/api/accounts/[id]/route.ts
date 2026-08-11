import { NextResponse } from "next/server";
import { maintenanceBlock } from "@/lib/maintenance";
import { incident, type IncidentCode } from "@/lib/incident";
import { getSupabaseServer } from "@/lib/supabase/server";
import { deleteAccount, rotateKeys, updateAccount } from "@/lib/accounts/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * How each internal failure reason surfaces to the browser.
 *
 * The mapping is explicit and total: a reason with no entry becomes
 * `INTERNAL`, which is the safe direction. Nothing derived from the failure
 * text reaches the client — those messages are written for a server log and
 * say operator things, including the Vault UUIDs and broker account numbers
 * these RPCs take as arguments.
 *
 * The internal reason string is not returned either. The UI branches on
 * `code`, which is a published contract; `db_error` names a branch in this
 * codebase and tells a caller nothing it may act on.
 */
const CLIENT_OUTCOME: Record<string, { code: IncidentCode; status: number }> = {
  not_found: { code: "NOT_FOUND", status: 404 },
  invalid_input: { code: "INVALID_INPUT", status: 400 },
  invalid_keys: { code: "INVALID_KEYS", status: 400 },
  no_credentials: { code: "INVALID_INPUT", status: 400 },
  network: { code: "BROKER_UNREACHABLE", status: 502 },
  alpaca_error: { code: "BROKER_ERROR", status: 502 },
  indeterminate: { code: "INDETERMINATE", status: 503 },
  db_error: { code: "INTERNAL", status: 500 },
};

function sanitized(
  reason: string,
  message: string,
  route: string,
): NextResponse {
  const { code, status } = CLIENT_OUTCOME[reason] ?? {
    code: "INTERNAL" as const,
    status: 500,
  };
  return NextResponse.json(incident(code, message, { route, reason }), { status });
}

/**
 * PATCH /api/accounts/[id]
 *  - { apiKey, apiSecret }                 → rotate credentials
 *  - { nickname?, color?, is_active? }      → update metadata
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const frozen = maintenanceBlock();
  if (frozen) return frozen;

  const { id } = await params;
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
    const result =
      typeof body.apiKey === "string" || typeof body.apiSecret === "string"
        ? await rotateKeys(
            user.id,
            id,
            String(body.apiKey ?? ""),
            String(body.apiSecret ?? ""),
          )
        : await updateAccount(user.id, id, {
            nickname: typeof body.nickname === "string" ? body.nickname : undefined,
            color: typeof body.color === "string" ? body.color : undefined,
            is_active:
              typeof body.is_active === "boolean" ? body.is_active : undefined,
          });

    if (!result.ok) {
      return sanitized(result.reason, result.message, "PATCH /api/accounts/[id]");
    }
    return NextResponse.json({ account: result.account });
  } catch (caught) {
    return NextResponse.json(
      incident(
        "INTERNAL",
        caught instanceof Error ? caught.message : "unknown error",
        { route: "PATCH /api/accounts/[id]" },
      ),
      { status: 500 },
    );
  }
}

/** DELETE /api/accounts/[id]?purgeHistory=true */
export async function DELETE(req: Request, { params }: Ctx) {
  const frozen = maintenanceBlock();
  if (frozen) return frozen;

  const { id } = await params;
  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const purgeHistory =
    new URL(req.url).searchParams.get("purgeHistory") === "true";

  try {
    const result = await deleteAccount(user.id, id, { purgeHistory });
    if (!result.ok) {
      return sanitized(result.reason, result.message, "DELETE /api/accounts/[id]");
    }
    return NextResponse.json({ ok: true });
  } catch (caught) {
    return NextResponse.json(
      incident(
        "INTERNAL",
        caught instanceof Error ? caught.message : "unknown error",
        { route: "DELETE /api/accounts/[id]" },
      ),
      { status: 500 },
    );
  }
}
