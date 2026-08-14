import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every environment variable read by browser-reachable code must be
 * NEXT_PUBLIC_-prefixed.
 *
 * WHY THIS EXISTS
 * ---------------
 * Next.js inlines `process.env.NEXT_PUBLIC_*` into the client bundle at build
 * time. Any other name is simply absent there — `process.env.FOO` evaluates to
 * `undefined` in the browser, silently, with no error and no warning.
 *
 * That asymmetry is dangerous precisely where two runtimes must AGREE. The
 * concrete case this guard was written for: `getAuthCookieName()` read
 * `process.env.SUPABASE_AUTH_COOKIE_NAME`. It is called from three places —
 * the browser client, the SSR server client, and the proxy. If an operator
 * ever set that variable, the server would honour it and the browser would
 * not see it at all, the two would look for different cookies, and every
 * signed-in user would be redirected to /login. The docstring on that very
 * function says preventing exactly this is its purpose.
 *
 * A unit test cannot catch it: vitest runs in Node, where both names are
 * visible, so a test that stubs the variable and asserts the override is
 * honoured PASSES while the browser half is broken. The defect is a property
 * of the build, not of the runtime behaviour in Node — so this is a static
 * check over the source, in the same spirit as browser-data-plane.test.ts.
 */

const DASHBOARD = join(__dirname, "..", "..");
const ROOTS = ["app", "components", "lib", "hooks"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "e2e"]);

/** Server-only modules: these never reach the browser bundle. */
const SERVER_ONLY = [
  /(^|\/)route\.ts$/, // Route Handlers
  /(^|\/)server\.ts$/, // SSR client factory
  /(^|\/)service\.ts$/, // service-role client
  /(^|\/)maintenance\.ts$/,
  /(^|\/)isolated-smoke\.ts$/,
  /\.test\.ts$/,
  /\.test\.tsx$/,
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a root that does not exist in this tree
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const ALL_FILES = ROOTS.flatMap((r) => walk(join(DASHBOARD, r)));

/**
 * Files reachable from the browser bundle. A module is browser-reachable if it
 * is a Client Component itself, or if any Client Component imports it
 * (transitively). Resolving the full import graph here would be its own source
 * of bugs, so the rule is deliberately conservative: everything that is not
 * explicitly server-only counts as reachable.
 */
const BROWSER_REACHABLE = ALL_FILES.filter(
  (f) => !SERVER_ONLY.some((re) => re.test(relative(DASHBOARD, f))),
);

/**
 * Reads that live in a browser-reachable MODULE but are only ever evaluated on
 * a server path — the module is imported by the browser, the function that
 * reads the variable is not called there.
 *
 * This is an audited allowlist, not a suppression list, and that distinction is
 * the whole design. A purely conservative rule flags ten reads of which nine
 * are fine; a rule that noisy gets weakened or deleted within a month. A rule
 * that fails on anything UNCLASSIFIED keeps its teeth: adding a new non-public
 * read to browser-reachable code fails this test until someone writes down why
 * it is safe. Each entry below is `path:VAR` with the reason it cannot reach
 * the browser.
 *
 * Note what is deliberately NOT here: SUPABASE_AUTH_COOKIE_NAME. That one is
 * read by getAuthCookieName(), which the browser client calls on every request.
 */
const CLASSIFIED_SERVER_READS: Record<string, string> = {
  "lib/status/github-api.ts:GITHUB_REPO":
    "read inside fetch helpers invoked only from Route Handlers",
  "lib/status/github-api.ts:GITHUB_STATE_REF":
    "read inside fetch helpers invoked only from Route Handlers",
  "lib/status/github-api.ts:GITHUB_TOKEN":
    "a credential; must never be inlined into a client bundle, and is not",
  "lib/status/read-model.ts:SUPABASE_SERVICE_ROLE_KEY":
    "a credential; read only when building the service-role client server-side",
  "lib/status/read-model.ts:BUILD_SHA":
    "stamped into the server-rendered payload, never read in the browser",
  "lib/status/read-model.ts:PRODUCTION_RELEASE_SHA":
    "server-side lineage check for the runtime state artifact",
  "lib/status/read-model.ts:V11_EPOCH_BASELINE":
    "server-side only; the epoch baseline is never exposed to the client",
  "lib/supabase/config.ts:ALLOW_LEGACY_DASHBOARD":
    "consulted by server-side guards only",
  "lib/supabase/config.ts:SUPABASE_SERVER_URL":
    "getSupabaseServerUrl() is called only from server.ts, service.ts and proxy.ts; " +
    "the internal origin must never appear in a client bundle, and the OCI bundle scan asserts it does not",
};

const ENV_READ = /process\.env\.([A-Z0-9_]+)/g;

describe("browser-reachable environment variables", () => {
  it("found a non-trivial set of files to scan", () => {
    // without this, a walker that silently returned nothing would make every
    // assertion below vacuously true
    expect(ALL_FILES.length).toBeGreaterThan(30);
    expect(BROWSER_REACHABLE.length).toBeGreaterThan(20);
  });

  it("reads only NEXT_PUBLIC_-prefixed or explicitly classified variables", () => {
    const offences: string[] = [];
    for (const file of BROWSER_REACHABLE) {
      const rel = relative(DASHBOARD, file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(ENV_READ)) {
        const name = m[1];
        if (name === "NODE_ENV") continue; // inlined by the bundler itself
        if (name.startsWith("NEXT_PUBLIC_")) continue;
        if (`${rel}:${name}` in CLASSIFIED_SERVER_READS) continue;
        offences.push(
          `${rel}: reads process.env.${name}, which Next.js does not inline ` +
            `into the client bundle. Either rename it to NEXT_PUBLIC_${name} ` +
            `or add "${rel}:${name}" to CLASSIFIED_SERVER_READS with a reason.`,
        );
      }
    }
    expect(offences).toEqual([]);
  });

  it("keeps the classification list honest — no stale entries", () => {
    // An entry that no longer matches any read is a rule nobody is enforcing.
    // Left in place it slowly turns the allowlist into folklore.
    const stale: string[] = [];
    for (const key of Object.keys(CLASSIFIED_SERVER_READS)) {
      const [rel, name] = key.split(":");
      const file = join(DASHBOARD, rel);
      let src = "";
      try {
        src = readFileSync(file, "utf8");
      } catch {
        stale.push(`${key} (file no longer exists)`);
        continue;
      }
      if (!src.includes(`process.env.${name}`)) stale.push(`${key} (no longer read)`);
    }
    expect(stale).toEqual([]);
  });
});
