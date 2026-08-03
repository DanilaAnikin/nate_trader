import { NextResponse } from "next/server";
import { V11_POLICY } from "@/lib/v11-policy";
import {
  LEGACY_DASHBOARD_ALLOWED,
  SUPABASE_CONFIGURED,
} from "@/lib/supabase/config";

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
      buildSha:
        process.env.BUILD_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
      dataMode: accountBackendConfigured
        ? "account-scoped"
        : explicitLegacyMode
          ? "legacy-explicit"
          : "unavailable",
    },
    {
      status: ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
