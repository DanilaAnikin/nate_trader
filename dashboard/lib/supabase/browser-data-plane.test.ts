import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The browser may talk to Supabase Auth. It may not talk to the data plane.
 *
 * Once the edge denies everything under `/rest/v1`, `/storage/v1`,
 * `/realtime/v1`, `/functions/v1` and `/graphql/v1`, any surviving browser
 * call to those paths is a feature that silently stops working in production
 * and works fine in every test and every local run. The failure is invisible
 * exactly where it matters, so it has to be caught in source.
 *
 * This test enumerates the filesystem rather than listing known offenders.
 * A list of files to check is a list that a new file is not on.
 */

const DASHBOARD = join(__dirname, "..", "..");
const SEARCH_ROOTS = ["app", "components", "lib", "hooks"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo"]);
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Match code, not prose.
 *
 * This guard used to read the raw file, so a docblock explaining that browser
 * code must never call `.from()` was itself reported as a call to `.from()`.
 * A comment describing a rule is not a violation of it, and a guard that
 * cannot tell the difference punishes the documentation that makes it
 * understandable — the surest way to get the documentation deleted.
 *
 * Stripping is also the safe direction here: comments can only ever produce
 * FALSE POSITIVES for these patterns, never false negatives, so removing them
 * costs no coverage. The positive control below proves the patterns still fire
 * on a real call after stripping.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Files that are allowed to reach the data plane, with the reason. */
const ALLOWED = new Map<string, string>([
  // The server-side boundary itself: these run in Node, over the internal
  // origin, and are the reason the browser no longer needs the data plane.
  ["app/api/profile/route.ts", "same-origin profile boundary (server)"],
]);

/**
 * Call shapes that reach a non-Auth Supabase surface. `.auth.` is deliberately
 * absent: signing in, refreshing and signing out are exactly what stays.
 */
const DATA_PLANE_CALLS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\.from\s*\(/, what: "PostgREST table access (.from)" },
  { pattern: /\.rpc\s*\(/, what: "PostgREST function call (.rpc)" },
  { pattern: /\.storage\b/, what: "Storage API (.storage)" },
  { pattern: /\.channel\s*\(/, what: "Realtime channel (.channel)" },
  { pattern: /\.removeChannel\s*\(/, what: "Realtime channel (.removeChannel)" },
  { pattern: /\.functions\b/, what: "Edge Functions (.functions)" },
  { pattern: /\/rest\/v1\b/, what: "literal /rest/v1 URL" },
  { pattern: /\/storage\/v1\b/, what: "literal /storage/v1 URL" },
  { pattern: /\/realtime\/v1\b/, what: "literal /realtime/v1 URL" },
  { pattern: /\/functions\/v1\b/, what: "literal /functions/v1 URL" },
  { pattern: /\/graphql\/v1\b/, what: "literal /graphql/v1 URL" },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE.test(name)) out.push(full);
  }
  return out;
}

/**
 * A file runs in the browser if it carries the "use client" directive, or if
 * it is a non-route file under app/ or components/ that a Client Component
 * can import. The conservative direction is to treat ambiguous files as
 * browser code, so this only exempts files that are unambiguously server-side.
 */
function isServerOnly(rel: string, src: string): boolean {
  if (/^app\/api\//.test(rel)) return true;
  if (/\.test\.(ts|tsx)$/.test(rel)) return true;
  if (/^lib\/supabase\/(server|service)\.ts$/.test(rel)) return true;
  if (/^middleware\.ts$/.test(rel)) return true;
  if (/^\s*import\s+["']server-only["']/m.test(src)) return true;
  return false;
}

const ALL_FILES = SEARCH_ROOTS.flatMap((r) => walk(join(DASHBOARD, r)));

describe("browser code never reaches the Supabase data plane", () => {
  it("finds source files to check", () => {
    // Guards the guard: a walker that silently returns nothing would make
    // every assertion below vacuous — the same class of defect as an empty
    // string comparing equal to an empty string.
    expect(ALL_FILES.length).toBeGreaterThan(30);
  });

  it("has no data-plane call in any browser-reachable file", () => {
    const offences: string[] = [];
    for (const file of ALL_FILES) {
      const rel = relative(DASHBOARD, file).split("\\").join("/");
      const raw = readFileSync(file, "utf8");
      const src = stripComments(raw);
      if (isServerOnly(rel, raw)) continue;
      if (ALLOWED.has(rel)) continue;
      for (const { pattern, what } of DATA_PLANE_CALLS) {
        if (pattern.test(src)) offences.push(`${rel}: ${what}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("still detects a real call after comments are stripped", () => {
    // Positive control for the stripping above. If removing comments also
    // removed the patterns' ability to fire, every green result would be an
    // artefact of the fix rather than a fact about the code.
    const real = stripComments(`
      /* this comment mentions .from( and .rpc( and /rest/v1 */
      // and so does this one: .storage
      const rows = await supabase.from("accounts").select("*");
    `);
    const hits = DATA_PLANE_CALLS.filter(({ pattern }) => pattern.test(real)).map((d) => d.what);
    expect(hits).toEqual(["PostgREST table access (.from)"]);
  });

  it("does not fire on a comment alone", () => {
    const proseOnly = stripComments(`
      /** Browser code must never call .from(), .rpc(), .storage or /rest/v1. */
      export const x = 1;
    `);
    const hits = DATA_PLANE_CALLS.filter(({ pattern }) => pattern.test(proseOnly));
    expect(hits).toEqual([]);
  });

  it("keeps the settings page off the data plane specifically", () => {
    // The three calls this programme removed. Named explicitly so the reason
    // survives even if the generic sweep above is ever relaxed.
    const src = readFileSync(join(DASHBOARD, "app/(app)/settings/page.tsx"), "utf8");
    expect(src).not.toMatch(/\.from\s*\(\s*["']profiles["']/);
    expect(src).toMatch(/fetch\(\s*["']\/api\/profile["']/);
  });

  it("allows Auth calls to remain in the browser", () => {
    const src = readFileSync(join(DASHBOARD, "app/(app)/settings/page.tsx"), "utf8");
    expect(src).toMatch(/supabase\.auth\./);
  });
});
