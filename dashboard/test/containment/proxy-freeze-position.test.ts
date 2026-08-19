import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./source-scan.mjs";

/**
 * Nothing decides anything before the freeze.
 *
 * WHY THIS EXISTS
 * ---------------
 * A proof-honesty audit inserted one line immediately above the freeze block:
 *
 *     if (request.headers.get("x-nt-operator") === "let-me-write") return response;
 *
 * A caller-controlled, unauthenticated bypass of the entire write freeze. The
 * Phase 1E harness reported `PHASE 1E GREEN — the unconditional freeze is
 * load-bearing`, and all 504 tests passed.
 *
 * Every existing check looks at the freeze block itself, or at what happens
 * when it is removed. None of them looked at what runs FIRST. The freeze can
 * be perfect and still never be reached, and "unconditional" is a claim about
 * position as much as about the condition — a word that appeared in the source
 * comment, in the harness banner and in three commit messages while being
 * asserted by nothing.
 *
 * The one denylist that came close (`proxy.test.ts`) named three identifiers —
 * bypassPossible, DASHBOARD_FREEZE_BYPASS_USERS, maintenanceFrozen — so any
 * bypass spelled differently walked through it. This asserts the shape of the
 * prologue instead of enumerating the names of things that must not be in it.
 */

const SRC = stripComments(readFileSync(join(__dirname, "..", "..", "proxy.ts"), "utf8"), "proxy.ts");

const FN = "export async function proxy(";
const FREEZE = "if (isApi && MUTATING_METHODS.has(request.method))";

/**
 * Everything that runs before the freeze can possibly be evaluated.
 *
 * Sliced from just after the function's own opening brace, not from the
 * signature: including it would leave the region permanently unbalanced and
 * the brace check below would have to be written as `opens === closes + 1`,
 * which is an assertion about this function's slicing rather than about the
 * code it is inspecting.
 */
function prologue(): string {
  const sig = SRC.indexOf(FN);
  expect(sig, "proxy() not found").toBeGreaterThan(-1);
  const open = SRC.indexOf("{", SRC.indexOf(")", sig));
  const freeze = SRC.indexOf(FREEZE);
  expect(freeze, "the freeze block is not in its expected form").toBeGreaterThan(open);
  return SRC.slice(open + 1, freeze);
}

describe("the write freeze is the first decision the proxy makes", () => {
  it("the prologue is non-empty and is the real one", () => {
    // Every assertion below is of the form "the prologue does not contain X",
    // and an EMPTY prologue satisfies all of them. Its passing value is also
    // its failure-to-run value.
    //
    // It was guarded, but only transitively: an empty region would fail the
    // return-count and branch-count checks further down. That is protection by
    // side effect, and a control that fires as somebody else's failure is one
    // nobody will recognise when it does. So the emptiness is asserted here,
    // in its own right, naming what it expects to find.
    const p = prologue();
    expect(p.length, "the prologue is empty — every check below would pass vacuously").toBeGreaterThan(100);
    expect(p).toContain("const path = request.nextUrl.pathname;");
    expect(p).toContain("const isApi =");
  });

  it("the freeze condition has exactly its two conjuncts", () => {
    // An extra `&& something` is how the flag gate came back the first time.
    // Matching the whole condition, not a substring of it, is what makes an
    // addition visible.
    expect(SRC).toContain(`${FREEZE} {`);
  });

  it("only one thing returns before the freeze, and it is the health check", () => {
    const returns = prologue().match(/\breturn\b/g) ?? [];
    expect(
      returns.length,
      "something returns before the write freeze — the freeze is not the first decision",
    ).toBe(1);
    expect(prologue()).toContain('if (path === "/api/health") return response;');
  });

  it("nothing caller-controlled is consulted before the freeze", () => {
    // PRECISELY: nothing caller-controlled BEYOND THE PATH. The health
    // short-circuit at the top of proxy() is `if (path === "/api/health")
    // return response;`, and `path` comes from request.nextUrl.pathname — so
    // the blanket phrasing this file used to carry ("nothing caller-controlled
    // is consulted before it") was not what the code does, and the test two
    // cases down explicitly blesses that return. The exemption is safe only
    // because the health route exports nothing mutating, which is now asserted
    // in its own right below rather than assumed.
    //
    // A bypass needs an input. The prologue may read the path and the method;
    // headers, cookies, body, query and search params are all attacker-chosen
    // and have no business influencing whether a write is refused.
    const forbidden = [
      "request.headers",
      "request.cookies",
      "req.headers",
      "headers.get",
      "cookies.get",
      "nextUrl.searchParams",
      "request.json",
      "request.text",
      "request.body",
    ];
    const found = forbidden.filter((f) => prologue().includes(f));
    expect(found, "the prologue consults caller-controlled input before the freeze").toEqual([]);
  });

  it("no environment variable is consulted before the freeze", () => {
    // This is what "unconditional" means operationally: no deployment-time
    // value can decide whether the refusal happens.
    expect(prologue()).not.toContain("process.env");
  });

  it("the prologue declares and does not branch", () => {
    // `if` appears exactly once in the prologue: the health short-circuit.
    // Any other branch is a decision taken before the freeze, which is the
    // shape every bypass has.
    const ifs = prologue().match(/\bif\s*\(/g) ?? [];
    expect(ifs.length, "there is a branch before the write freeze").toBe(1);
  });

  it("the one path exempted before the freeze exports nothing mutating", () => {
    // The health short-circuit returns before the freeze can run, so anything
    // mutating added to that route would be edge-unfrozen. Today it is GET
    // only; this makes that a checked property of the exemption rather than a
    // fact somebody happened to know.
    const health = stripComments(
      readFileSync(join(__dirname, "..", "..", "app", "api", "health", "route.ts"), "utf8"),
      "app/api/health/route.ts",
    );
    // EVERY export form Next accepts, not just the declaration one. The first
    // version matched only `export [async] function NAME` / `export const NAME`,
    // so `export { POST }` or `export { handler as POST }` — both of which Next
    // honours — would have left this green while sitting behind the pre-freeze
    // `if (path === "/api/health") return response;`, i.e. edge-unfrozen. That
    // is the same narrowing this commit series exists to remove.
    const exported = new Set<string>();
    for (const m of health.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
      exported.add(m[1]);
    }
    for (const block of health.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const clause of block[1].split(",")) {
        const name = clause.trim().split(/\s+as\s+/).pop();
        if (name) exported.add(name.trim());
      }
    }
    const handlers = [...exported].filter((n) => /^[A-Z]+$/.test(n));
    expect(handlers.length, "no exported handlers found in the health route — this check would be vacuous")
      .toBeGreaterThan(0);
    expect(handlers.sort(), "the pre-freeze exemption now covers a mutating handler").toEqual(["GET"]);

    // Non-vacuity on the ENUMERATOR, not just on its answer: the same reader,
    // pointed at each form in turn, must actually see a POST. Otherwise "only
    // GET is exported" is indistinguishable from "the reader sees nothing".
    const seesPost = (src: string) => {
      const found = new Set<string>();
      for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) found.add(m[1]);
      for (const b of src.matchAll(/export\s*\{([^}]*)\}/g))
        for (const c of b[1].split(",")) { const n = c.trim().split(/\s+as\s+/).pop(); if (n) found.add(n.trim()); }
      return found.has("POST");
    };
    expect(seesPost("export async function POST() {}"), "declaration form not seen").toBe(true);
    expect(seesPost("export const POST = () => {};"), "const form not seen").toBe(true);
    expect(seesPost("async function h() {}\nexport { h as POST };"), "aliased re-export not seen").toBe(true);
    expect(seesPost("async function POST() {}\nexport { POST };"), "plain re-export not seen").toBe(true);
    expect(seesPost("export async function GET() {}"), "the reader invents a POST that is not there").toBe(false);
  });

  it("the freeze is not inside a conditional block", () => {
    // Position is not enough on its own — the freeze could sit first and still
    // be nested inside something that never runs. Between the health check and
    // the freeze there must be no unclosed `{`.
    const p = prologue();
    const opens = (p.match(/\{/g) ?? []).length;
    const closes = (p.match(/\}/g) ?? []).length;
    expect(opens, "the freeze appears to be nested inside a block").toBe(closes);
  });
});
