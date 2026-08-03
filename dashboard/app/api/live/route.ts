import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Retired global credential endpoint.
 *
 * Multi-account pages must use the authenticated, ownership-checked
 * /api/accounts/[id]/live route. Keeping a non-mutating 410 response makes old
 * dashboard bundles fail closed while clients roll over during deployment.
 */
export async function GET() {
  return NextResponse.json(
    {
      code: "LEGACY_ENDPOINT_RETIRED",
      error: "Use the authenticated account-scoped live endpoint.",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
