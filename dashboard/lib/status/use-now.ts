"use client";

import { useSyncExternalStore } from "react";

/**
 * A coarse, subscribed clock.
 *
 * Relative ages ("4m ago") must keep ticking, but reading `Date.now()` during
 * render is impure and would also produce a server/client hydration mismatch.
 * Bucketing to 30 seconds through an external store keeps render pure and
 * limits re-renders to twice a minute.
 */
const BUCKET_MS = 30_000;

function subscribe(onStoreChange: () => void): () => void {
  const id = setInterval(onStoreChange, BUCKET_MS);
  return () => clearInterval(id);
}

function getSnapshot(): number {
  return Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
}

/** On the server there is no meaningful "now" for the viewer; ages wait for hydration. */
function getServerSnapshot(): number {
  return 0;
}

export function useNowMs(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
