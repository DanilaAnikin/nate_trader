import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The proxy must be INVOKED on every API path — the half no test was checking.
 *
 * Every other proxy test calls `proxy()` directly with a synthetic request.
 * Those prove the function refuses; none can see whether it runs, because that
 * is decided by `config.matcher`. An audit found what that gap cost: the
 * matcher's negative lookahead ended in `.*\.(?:svg|png|...)$`, where `.*`
 * spans the whole path, so `DELETE /api/accounts/abc.png` skipped the proxy
 * entirely — no edge freeze, no authentication — while 504 tests stayed green.
 *
 * Two layers here, deliberately at different strengths:
 *
 *   - The source assertion runs always, with no build, and catches the entry
 *     being deleted or weakened.
 *   - The compiled assertion is the real proof, because it reads what Next
 *     actually produced. It runs whenever a build is present, and
 *     test/containment/proxy-matcher.mjs runs it in the gate where a build is
 *     guaranteed and its absence is a hard failure.
 *
 * Checking the compiled output matters more than it sounds: the bug was not a
 * typo in the source, it was a correct-looking regex whose meaning only became
 * visible once evaluated against real paths.
 */

const DASH = join(__dirname, "..", "..");
const SRC = readFileSync(join(DASH, "proxy.ts"), "utf8");
const MANIFEST = join(DASH, ".next", "server", "functions-config-manifest.json");

/** The extensions the old lookahead excluded — the exact shape of the bypass. */
const EXTS = ["svg", "png", "jpg", "jpeg", "gif", "webp", "ico"];

describe("the proxy is wired to run on the API surface", () => {
  it("states /api positively, as its own matcher entry", () => {
    // An exclusion list is the wrong shape for a security boundary: it is a
    // claim about everything you did not think of. /api must be asserted, not
    // left as a residue of what the exclusions happened to miss.
    expect(
      SRC.includes('"/api/:path*"'),
      'config.matcher must contain "/api/:path*" so no exclusion can carve a hole in the API surface',
    ).toBe(true);
  });

  it("does not leave the API surface to a negative lookahead alone", () => {
    const matcherBlock = SRC.slice(SRC.indexOf("export const config"));
    const lookaheads = matcherBlock.match(/"\/\(\(\?![^"]*"/g) ?? [];
    for (const l of lookaheads) {
      expect(
        l.includes("?!api|"),
        `this lookahead may still cover /api: ${l}. Exclude api from it and let the positive entry own that surface.`,
      ).toBe(true);
    }
  });
});

describe("Next's compiled matcher, when a build is present", () => {
  const built = existsSync(MANIFEST);

  it("defers to a layer that exists and can enforce it", () => {
    // `expect(typeof built).toBe("boolean")` used to be here. It is true
    // whether or not a build exists, whether or not this file loaded correctly,
    // and whether or not the deferral it describes is real — its passing value
    // is its failure-to-run value, which is the shape this suite exists to
    // reject. It also mattered: in CI `npm test` runs BEFORE `npm run build`,
    // so `built` is false and the assertion below never executes there.
    //
    // What can honestly be checked from this checkout is that the layer being
    // deferred TO is present and substantial. Whether the gate invokes it is
    // NOT checkable here: the workflow lives on the trusted branch, not in this
    // one, so this file cannot see it. It runs `node test/containment/
    // proxy-matcher.mjs` after the production build.
    const enforcer = join(__dirname, "proxy-matcher.mjs");
    expect(existsSync(enforcer), "the layer this test defers to does not exist").toBe(true);
    const body = readFileSync(enforcer, "utf8");
    expect(body.length, "the deferred-to enforcer is empty").toBeGreaterThan(500);
    expect(body, "the enforcer does not read Next's compiled matcher").toContain(
      "functions-config-manifest.json",
    );
    expect(body, "the enforcer does not fail when there is no build").toMatch(/exit\(1\)|process\.exitCode/);
  });

  it.runIf(built)("runs on every API path, including extension-suffixed ones", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const matchers = manifest?.functions?.["/_middleware"]?.matchers ?? [];
    expect(matchers.length, "no /_middleware matchers — the proxy is not wired up").toBeGreaterThan(0);

    const regexes = matchers.map((m: { regexp: string }) => new RegExp(m.regexp));
    const runs = (p: string) => regexes.some((r: RegExp) => r.test(p));

    const missed = [
      "/api",
      "/api/accounts",
      "/api/accounts/abc",
      "/api/profile",
      ...EXTS.map((e) => `/api/accounts/abc.${e}`),
    ].filter((p) => !runs(p));
    expect(missed, "the proxy does not run on these API paths").toEqual([]);

    // and it is still discriminating, or the line above is vacuous
    expect(runs("/_next/static/chunks/main.js")).toBe(false);
    expect(runs("/logo.png")).toBe(false);
  });
});
