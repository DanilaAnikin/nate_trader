import "server-only";

/**
 * Running this image as a smoke-test sidecar.
 *
 * ## What is *not* a control here
 *
 * An earlier version decided "is this request from loopback?" from the `Host`
 * header, and refused everything else in the proxy. That was not isolation. A
 * `Host` header is chosen by the caller: anything that can reach the port can
 * send `Host: localhost`, so the check refused honest remote clients and
 * admitted the one attacker it was written for. Absence of `x-forwarded-*` is
 * no better — a direct connection to an exposed port carries neither.
 *
 * There is no header an application can read that proves where a connection
 * came from. So this module no longer pretends to.
 *
 * ## What the isolation actually is
 *
 * Three deployment facts, none of them expressible in this file:
 *
 *   1. the container publishes its port on `127.0.0.1` only
 *      (`-p 127.0.0.1:PORT:3000`), so the kernel refuses off-host connections;
 *   2. the host firewall / private network admits nothing else to that port;
 *   3. the operator reaches it through an SSH tunnel to that loopback address.
 *
 * The runbook states all three and the operator verifies (1) and (2) from
 * outside the host before the sidecar is given credentials.
 *
 * ## What this file *is* for
 *
 * One thing: the freeze bypass. During the migration window the mutation smoke
 * tests need writes to work **for the operator** while remaining blocked for
 * everyone else, which a single global freeze flag cannot express.
 *
 *   * `DASHBOARD_SIDECAR_ONLY=on` — the operator's assertion that this image
 *     is deployed under the isolation above. It grants nothing on its own; it
 *     is the precondition without which the allowlist is inert, so a bypass
 *     list left behind on a public image does nothing.
 *   * `DASHBOARD_FREEZE_BYPASS_USERS` — Supabase user ids whose mutations pass
 *     the freeze. Empty means nobody, which is its value except during step 9.
 *
 * The bypass is keyed on the *authenticated user* precisely because a header
 * cannot be trusted: the session cookie is verified against Supabase, and the
 * point of the window is that exactly one operator can write.
 */

const ON_VALUES: ReadonlySet<string> = new Set(["on", "1", "true", "yes"]);

function flag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw !== undefined && ON_VALUES.has(raw);
}

export function sidecarOnly(): boolean {
  return flag("DASHBOARD_SIDECAR_ONLY");
}

/** The allowlisted operator user ids. Empty unless the runbook says otherwise. */
export function freezeBypassUsers(): ReadonlySet<string> {
  const raw = process.env.DASHBOARD_FREEZE_BYPASS_USERS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * True when this user may write despite the freeze.
 *
 * Both conditions, always: the image must be running as an isolated sidecar,
 * *and* the user must be named. An allowlist on a publicly reachable image
 * would be a way to write to production during a migration.
 */
export function mayBypassFreeze(userId: string | null | undefined): boolean {
  if (!userId) return false;
  if (!sidecarOnly()) return false;
  return freezeBypassUsers().has(userId);
}
