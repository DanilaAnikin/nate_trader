import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The route-object extractor runs, and its shared imports resolve.
 *
 * WHY THIS EXISTS
 * ---------------
 * This module is executed by exactly one gate — the schema-compatibility job —
 * which needs psql and a pinned Postgres image and is therefore not part of
 * `npm test`. So when the seventh copy of `stripComments` was consolidated into
 * a bare `export { stripComments } from "…"`, nothing local noticed that a
 * re-export creates NO LOCAL BINDING while this module calls the function
 * itself. It failed in CI with `ReferenceError: stripComments is not defined`,
 * three minutes into a job that first pulls a database image by digest.
 *
 * A module that only one slow gate exercises is a module whose breakage is
 * discovered slowly. This runs it directly: no database, no docker, just the
 * extraction, which is the part that can break from a refactor next door.
 */
const DASH = join(__dirname, "..", "..");

describe("the schema-compat route extractor", () => {
  it("runs, resolves its shared imports, and emits a report", () => {
    const out = execFileSync(
      process.execPath,
      [join(DASH, "test/schema-compat/extract-route-objects.mjs"), "--dashboard", DASH],
      { encoding: "utf8", timeout: 120_000 },
    );
    const report = JSON.parse(out);
    expect(report.apiRoot).toBe("app/api");
    // Non-vacuity: an extractor that found nothing would emit a valid report too.
    expect(report.routeFileCount, "no route files found — the extraction is not working").toBeGreaterThan(0);
  });

  it("would have caught the missing local binding", () => {
    // The bug was `export { stripComments } from "…"` with no import: a
    // re-export creates no LOCAL binding, and this module calls the function.
    // Reproduced by pointing the CLI at a tree and watching it die with
    // ReferenceError — which is exactly what the case above does, so the guard
    // here is that the module's source really does IMPORT the name it calls,
    // not merely forward it.
    const src = readFileSync(join(DASH, "test/schema-compat/extract-route-objects.mjs"), "utf8");
    expect(src, "the module calls stripComments").toMatch(/\bstripComments\s*\(/);
    expect(src, "…so it must import the binding, not only re-export it").toMatch(
      /import\s*\{[^}]*\bstripComments\b[^}]*\}\s*from/,
    );
  });
});
