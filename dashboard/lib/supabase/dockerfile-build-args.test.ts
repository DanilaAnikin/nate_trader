import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every NEXT_PUBLIC_ variable the source reads must be declared as a build ARG
 * in the Dockerfile's builder stage.
 *
 * WHY THIS EXISTS
 * ---------------
 * `NEXT_PUBLIC_*` is inlined into the client bundle at BUILD time. A value
 * supplied to the container at runtime reaches SSR and the proxy but is simply
 * absent from the browser bundle — `undefined`, silently.
 *
 * browser-env.test.ts catches the inverse mistake (reading a non-public name in
 * browser code). This catches the one that bit the cookie pin: the name is
 * correctly NEXT_PUBLIC_, the code reads it, the deployment sets it — and it
 * still never reaches the browser, because the image was never built with it.
 * The result is the same silent divergence: SSR honours the value, the browser
 * derives a different one, and every signed-in user is redirected to /login.
 *
 * The two guards together mean a public variable is either wired end to end or
 * the suite is red.
 */

const DASHBOARD = join(__dirname, "..", "..");
const DOCKERFILE = join(DASHBOARD, "Dockerfile");
const ROOTS = ["app", "components", "lib", "hooks"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "e2e"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const ALL_FILES = ROOTS.flatMap((r) => walk(join(DASHBOARD, r))).filter(
  (f) => !/\.test\.tsx?$/.test(f),
);

const dockerfile = readFileSync(DOCKERFILE, "utf8");

/** ARG names declared anywhere in the Dockerfile. */
const DECLARED_ARGS = new Set(
  [...dockerfile.matchAll(/^\s*ARG\s+([A-Z0-9_]+)/gm)].map((m) => m[1]),
);

/** Public vars actually read by the source. */
const READ_PUBLIC = new Set<string>();
for (const file of ALL_FILES) {
  for (const m of readFileSync(file, "utf8").matchAll(
    /process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g,
  )) {
    READ_PUBLIC.add(m[1]);
  }
}

describe("Dockerfile build args cover every public variable", () => {
  it("found the Dockerfile and a non-trivial set of sources", () => {
    expect(dockerfile.length).toBeGreaterThan(200);
    expect(ALL_FILES.length).toBeGreaterThan(30);
    expect(READ_PUBLIC.size).toBeGreaterThan(0);
  });

  it("declares an ARG for every NEXT_PUBLIC_ variable the code reads", () => {
    const missing = [...READ_PUBLIC]
      .filter((name) => !DECLARED_ARGS.has(name))
      .sort()
      .map(
        (name) =>
          `${name} is read by the source but has no "ARG ${name}" in the Dockerfile, ` +
          `so it will be undefined in the browser bundle however it is set at runtime`,
      );
    expect(missing).toEqual([]);
  });

  it("sets each of those ARGs as an ENV in the builder stage", () => {
    // ARG alone is not enough: Next.js reads process.env during `npm run build`,
    // so the value has to be promoted to ENV before the build step runs.
    const builder = dockerfile.slice(
      dockerfile.indexOf("AS builder"),
      dockerfile.indexOf("AS runner") > 0
        ? dockerfile.indexOf("AS runner")
        : dockerfile.length,
    );
    const notPromoted = [...READ_PUBLIC]
      .filter((name) => !new RegExp(`^\\s*ENV\\s+${name}=`, "m").test(builder))
      .sort();
    expect(notPromoted).toEqual([]);
  });

  it("lists which public variables are wired, for the record", () => {
    const wired = [...READ_PUBLIC].sort();
    // not an assertion about the exact set — a visible inventory, so that adding
    // one shows up in a diff rather than passing silently
    expect(wired.length).toBe(wired.filter((n) => DECLARED_ARGS.has(n)).length);
  });
});
