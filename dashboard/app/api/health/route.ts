import { NextResponse } from "next/server";
import { V11_POLICY } from "@/lib/v11-policy";
import {
  LEGACY_DASHBOARD_ALLOWED,
  SUPABASE_CONFIGURED,
} from "@/lib/supabase/config";
import {
  ARTIFACT_ROLE,
  CREDENTIAL_MUTATION_COMPATIBLE,
  UNFROZEN_COMPATIBLE,
  WRITES_ENABLED,
} from "@/lib/frozen";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const accountBackendConfigured =
    SUPABASE_CONFIGURED && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const explicitLegacyMode =
    !SUPABASE_CONFIGURED && LEGACY_DASHBOARD_ALLOWED;
  const ready = accountBackendConfigured || explicitLegacyMode;

  return NextResponse.json(
    {
      status: ready ? "ok" : "misconfigured",
      service: "nate-trader-dashboard",
      strategyVersion: V11_POLICY.strategyVersion,
      // Self-hosted container: `BUILD_SHA` is the only supported source.
      buildSha: process.env.BUILD_SHA ?? "unknown",
      dataMode: accountBackendConfigured
        ? "account-scoped"
        : explicitLegacyMode
          ? "legacy-explicit"
          : "unavailable",
      // Non-secret artifact identity. Anything consuming this response must be
      // able to tell a frozen containment bridge from the unfrozen candidate,
      // so it can never be mistaken for one. These are compile-time constants
      // from lib/frozen.ts, not environment reads — there is no configuration
      // that makes this image claim to be something else.
      artifact_role: ARTIFACT_ROLE,
      writes_enabled: WRITES_ENABLED,
      unfrozen_compatible: UNFROZEN_COMPATIBLE,
      credential_mutation_compatible: CREDENTIAL_MUTATION_COMPATIBLE,
    },
    {
      status: ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
