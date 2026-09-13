import raw from "./runtime-handoff-raw-fixture.json";

/**
 * Synthetic seven-file handoff, generated with the Python plan/intent/client-ID
 * and handoff digest functions. No production account or runtime data is used.
 *
 * Keep entry values as raw strings: Python emits 23.0/0.0 and ASCII-escaped
 * Unicode, which a JSON.parse/stringify round trip changes. The manifest pins
 * those original bytes. Both run timestamps match the ordinary test windows.
 */
export function runtimeHandoffFixture(): {
  entries: Record<string, string>;
  pin: string;
  sourceIdentity: string;
  targetIdentity: string;
  sourceSha: string;
  targetSha: string;
  universeSha256: string;
  now: Date;
} {
  return {
    ...raw,
    entries: { ...raw.entries },
    now: new Date(raw.now),
  };
}
