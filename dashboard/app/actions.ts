"use server";

import { revalidatePath } from "next/cache";

/**
 * Force Next.js to drop all cached fetches for the dashboard layout and
 * re-fetch fresh data from GitHub on the next render. Called by the
 * <RefreshButton/> client component when the user clicks Refresh.
 *
 * Returns the timestamp the cache was invalidated — the client can show
 * "Last refreshed: HH:MM:SS" UX without a follow-up round trip.
 */
export async function refreshAll(): Promise<{ ok: true; ts: string }> {
  revalidatePath("/", "layout");
  return { ok: true, ts: new Date().toISOString() };
}
