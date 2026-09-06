import { frozenResponse } from "@/lib/frozen";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * POST /api/accounts/[id]/refresh — FROZEN on this containment bridge.
 *
 * On the development dashboard this re-fetches the Alpaca portfolio history and
 * activity feed and publishes both broker mirrors: the one control that writes
 * financial data. This build is the read-only containment bridge and publishes
 * nothing, so the route returns the frozen 503 unconditionally — before any
 * client, session, or broker call — exactly like every other mutating handler
 * in this image. It is deliberately NOT gated on DASHBOARD_MAINTENANCE_MODE:
 * the freeze here is a property of the artifact, not of an environment
 * variable. test/containment/permanent-freeze.test.ts enforces it.
 */
export async function POST(): Promise<Response> {
  return frozenResponse();
}
