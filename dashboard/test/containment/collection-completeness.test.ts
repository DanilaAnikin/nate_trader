import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every test on disk is a test that runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * `vitest.config.mts` used to list root/extension pairs — lib/**\/*.test.ts,
 * app/**\/*.test.ts, components/**\/*.test.tsx, test/**\/*.test.ts — and the
 * pairs did not cover the grid. A proof-honesty audit added four files, each
 * containing nothing but `expect(1).toBe(2)`:
 *
 *     test/containment/never-collected.test.tsx    not collected
 *     lib/never-collected.test.tsx                 not collected
 *     app/never-collected.test.tsx                 not collected
 *     components/never-collected.test.ts           not collected
 *
 * The reported file count did not move and the suite stayed green. Four tests
 * that could not pass, passing.
 *
 * That is the worst failure a test suite has, because it is invisible from
 * both directions: the author sees a green run, and the reviewer sees a file
 * full of assertions. Nothing anywhere asserted that the set of files vitest
 * COLLECTS equals the set of files that exist.
 *
 * This is that assertion. It is deliberately structural rather than dynamic —
 * a test cannot ask vitest what it collected without the answer depending on
 * the very collection being checked — so it reads the config's include
 * patterns and requires every test file on disk to be matched by one.
 */

const DASH = join(__dirname, "..", "..");
const CONFIG = join(DASH, "vitest.config.mts");
const SKIP = new Set(["node_modules", ".next", "dist", "e2e"]);
const TEST_FILE = /\.test\.[a-z]+$/;

/** Every file that calls itself a test, wherever it lives. */
function testFiles(dir = DASH, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e) || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (TEST_FILE.test(e)) out.push(relative(DASH, p));
  }
  return out.sort();
}

const FILES = testFiles();
const CONFIG_SRC = readFileSync(CONFIG, "utf8");

/** The include patterns, read from the config rather than restated here. */
function includePatterns(): string[] {
  const m = CONFIG_SRC.match(/include:\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
}

/**
 * The smallest glob-to-regex conversion that covers the forms actually used
 * here: `**` across separators, `*` within a segment, and `{a,b}` alternation.
 * Its correctness is asserted below rather than assumed — a broken converter
 * would make every check in this file pass.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      out += `(?:${glob.slice(i + 1, close).split(",").join("|")})`;
      i = close;
    } else if (".+^$()|[]\\".includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}

describe("the glob converter this file depends on", () => {
  // If this were wrong, "every file matches a pattern" could be true for
  // reasons unrelated to the config, and the whole file would be decoration.
  it("matches what it should", () => {
    const r = globToRegExp("**/*.test.{ts,tsx}");
    expect(r.test("a.test.ts")).toBe(true);
    expect(r.test("lib/a.test.ts")).toBe(true);
    expect(r.test("test/containment/a.test.tsx")).toBe(true);
  });

  it("does not match what it should not", () => {
    const r = globToRegExp("lib/**/*.test.ts");
    expect(r.test("app/a.test.ts")).toBe(false);
    expect(r.test("lib/a.test.tsx")).toBe(false);
    expect(r.test("lib/a.ts")).toBe(false);
  });
});

describe("every test file on disk is collected", () => {
  it("found test files", () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it("read the include patterns from the config", () => {
    expect(includePatterns().length).toBeGreaterThan(0);
  });

  it("no test file falls outside every include pattern", () => {
    const patterns = includePatterns().map(globToRegExp);
    const orphans = FILES.filter((f) => !patterns.some((p) => p.test(f)));
    expect(
      orphans,
      "these files name themselves tests and vitest will never run them — they pass by not running",
    ).toEqual([]);
  });

  it("covers the whole extension/root grid, not a list of pairs", () => {
    // The specific shape that failed: a .tsx test under test/, and a .ts test
    // under components/. Checked as hypotheticals so the guard holds even
    // when no such file currently exists.
    const patterns = includePatterns().map(globToRegExp);
    const hypothetical = [
      "test/containment/x.test.tsx",
      "lib/x.test.tsx",
      "app/x.test.tsx",
      "components/x.test.ts",
      "proxy.test.ts",
      "x.test.mts",
    ];
    const uncovered = hypothetical.filter((f) => !patterns.some((p) => p.test(f)));
    expect(uncovered, "these placements would not be collected").toEqual([]);
  });
});
