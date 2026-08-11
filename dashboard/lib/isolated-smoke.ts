import "server-only";

/**
 * Who may reach this image while it is being smoke-tested.
 *
 * The deployment runbook says to run the bridge and the candidate
 * "side-by-side", and the obvious way to do that — publish both and click
 * around — is wrong in two directions. With the freeze **off**, the bridge's
 * lifecycle writes are reachable by ordinary users on the real database. And
 * the disposable-observer mutation tests need writes to work *for the
 * operator* while remaining blocked for everyone else, which a single global
 * flag cannot express.
 *
 * So the sidecar is bound to loopback (or a private network) and, when it must
 * accept a mutation during a freeze, only from an explicitly allowlisted
 * operator session.
 *
 * Two environment variables, both absent in normal operation:
 *
 *   * `DASHBOARD_SIDECAR_ONLY=on` — refuse every request that did not arrive
 *     over loopback. This is the "not available to ordinary users" half, and
 *     it is enforced in the proxy, before authentication, so a
 *     misconfiguration fails closed rather than serving the internet.
 *   * `DASHBOARD_FREEZE_BYPASS_USERS` — a comma-separated list of Supabase
 *     user ids whose mutations pass the freeze. Empty means nobody, which is
 *     the value it should hold except during step 9 of the runbook.
 *
 * The bypass is deliberately keyed on the *authenticated user*, not on a
 * header or a token: a header can be forged by anything that reaches the port,
 * and the point of this window is that exactly one operator can write.
 */

const ON_VALUES: ReadonlySet<string> = new Set(["on", "1", "true", "yes"]);

function flag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw !== undefined && ON_VALUES.has(raw);
}

export function sidecarOnly(): boolean {
  return flag("DASHBOARD_SIDECAR_ONLY");
}

/**
 * Whether a request arrived over loopback.
 *
 * `x-forwarded-for` is only consulted to *reject*: a request carrying one has
 * been through a proxy, which is exactly what a sidecar is not supposed to be
 * reachable through. Trusting it to prove loopback would let a caller assert
 * its own address.
 */
export function isLoopback(request: {
  headers: { get(name: string): string | null };
  url: string;
}): boolean {
  if (request.headers.get("x-forwarded-for") !== null) return false;
  if (request.headers.get("x-forwarded-host") !== null) return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const bare = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
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
