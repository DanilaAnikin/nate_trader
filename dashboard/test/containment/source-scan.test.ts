import { describe, expect, it } from "vitest";
import { stripComments, hasUseServer } from "./source-scan.mjs";

/**
 * The comment stripper, and the two ways the hand-written one was defeated.
 *
 * WHY THIS EXISTS
 * ---------------
 * Six checks decide whether the containment proof holds by reading source with
 * comments removed. That helper was, in turn: two `replace` calls (defeated by
 * a regex literal containing a slash), then a hand-written character scanner
 * (defeated twice more), and is now TypeScript's own parser.
 *
 * Each case below runs BOTH implementations. The old one is inlined verbatim,
 * not described, so "the old rule would have missed this" is executed rather
 * than asserted — the same discipline the rest of this suite uses, and the
 * reason mutant 35 was caught passing for the wrong reason.
 */

/** The hand-written scanner, exactly as shipped at 117a1e82e. */
function handRolled(src: string): string {
  const REGEX_MAY_FOLLOW =
    /[=(,:[!&|?{};+\-*%^~<>]$|\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c; i += 1;
      while (i < src.length) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        out += src[i];
        if (src[i] === c) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === "/" && REGEX_MAY_FOLLOW.test(out.replace(/\s+$/, ""))) {
      out += c; i += 1;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { out += src[i]; i += 1; break; }
        else if (src[i] === "\n") break;
        out += src[i]; i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

describe("stripComments survives the constructs that defeated its predecessors", () => {
  it("SCAN-1: a regex literal in STATEMENT position does not eat the line", () => {
    // `if (cond) /re/…` — `)` is not in the old heuristic's follow set, so the
    // regex was read as division, its body copied into the code stream, and the
    // `//` inside the URL pattern then deleted the rest of the line. An auditor
    // used exactly this to hide a tombstoned-routine call from the analyzer,
    // which reported PASS.
    const src =
      'if (user.id.length) /^https?:\\/\\//.test(user.id); await supa.rpc("vault_create_secret");';
    expect(handRolled(src), "the fixture is not the attack shape").not.toContain('rpc("vault_create_secret")');
    expect(stripComments(src, "route.ts")).toContain('rpc("vault_create_secret")');
  });

  it("SCAN-1b: and the same in the position the old scanner DID handle", () => {
    // The control. Mutant 35 wrote the regex after `=`, which the old scanner
    // handled — which is why it caught that mutant and missed the one above.
    const src = 'const sep = /\\//; await supa.rpc("vault_create_secret");';
    expect(handRolled(src)).toContain('rpc("vault_create_secret")');
    expect(stripComments(src, "route.ts")).toContain('rpc("vault_create_secret")');
  });

  it("SCAN-2: an apostrophe in JSX text does not open a string", () => {
    // `Don't` opened a quote state that ran to the next `'` anywhere in the
    // file; code in between was treated as string content, and a `//` in a URL
    // inside a real string then ate the rest of that line. This was a STRICT
    // REGRESSION — the original two-`replace` form got it right.
    // The CLOSING apostrophe matters as much as the opening one. With no second
    // `'` the string state simply runs to EOF and the text survives verbatim —
    // which is why the first version of this fixture did not reproduce and the
    // non-vacuity assertion below rejected it. Here `can't` closes the state
    // mid-way through a real double-quoted string, code mode resumes INSIDE
    // that string, and the `//` of the URL is then eaten as a line comment,
    // taking the table write on the same line with it.
    const src =
      "export function Hint() { return <p>Don't panic</p>; }\n" +
      'export function Panel() { const help = "if it can\'t load, see https://docs.example.com/x"; void svc.from("accounts").delete().eq("id", 1); }\n';
    expect(handRolled(src), "the fixture is not the attack shape").not.toContain('from("accounts")');
    expect(stripComments(src, "Hint.tsx")).toContain('from("accounts")');
  });

  it("still removes real comments, in both syntaxes and at end of file", () => {
    // Non-vacuity in the other direction: a stripper that returned its input
    // unchanged would pass every case above and be useless.
    const src = '// a line comment mentioning https://x\n/* a block comment */ const q = 1; // trailing\n';
    const out = stripComments(src, "x.ts");
    expect(out).not.toContain("line comment mentioning");
    expect(out).not.toContain("a block comment");
    expect(out).not.toContain("trailing");
    expect(out).toContain("const q = 1;");
  });

  it("preserves byte offsets and line structure, so downstream positions stay true", () => {
    const src = 'const a = 1; // xxxx\nconst b = 2;\n/* yy\nzz */\nconst c = 3;\n';
    const out = stripComments(src, "x.ts");
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
  });

  it("hasUseServer reads the whole file and is not fooled by prose", () => {
    expect(hasUseServer('"use server";\nexport const a = 1;\n', "a.ts")).toBe(true);
    expect(hasUseServer("/* about the \"use server\" directive */\nexport const b = 2;\n", "b.ts")).toBe(false);
    expect(hasUseServer("export const c = 3;\n", "c.ts")).toBe(false);
  });
});
