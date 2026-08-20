import ts from "typescript";

/**
 * ONE definition of "what does this source actually say", imported by the
 * reachability analyzer and by every containment test that needs to read
 * source without being fooled by it.
 *
 * It lives in its own module because it had been COPIED into five files —
 * reachability.mjs, client-mutations.test.ts, route-surface-complete.test.ts,
 * proxy-freeze-position.test.ts and app/api/route-surface.test.ts — and when
 * an audit found the copy in one of them could be defeated by a regex literal,
 * all five had the hole. A rule that decides whether the containment proof
 * holds should exist once.
 */

/** Source with comments removed, so prose about a directive is not a directive.
 *
 * SCANNED, not regexed. The previous form was two `replace` calls, and the
 * second — `/(^|[^:])\/\/.*$/gm` — cannot tell a comment from a slash inside a
 * literal. A single regex literal containing a slash was enough to delete the
 * rest of the line:
 *
 *     const sep = /\//; await svc.from("accounts").update({…}).eq("id", id);
 *
 * stripped to `const sep = /\` — and the table write vanished from every
 * downstream check, so the module was not mutation surface and the closure
 * containing it was clean. The same helper had been copied into four test
 * files, so all of them had the hole.
 *
 * The implementation is TypeScript's parser, so the paragraph that used to sit
 * here — describing a hand-written walk that treated '…', "…", `…` and /…/ as
 * opaque — no longer describes anything. Its stated KNOWN LIMIT went with it:
 * a template literal whose `${}` interpolation contains a backtick was said to
 * be "consumed as one literal… conservative in the safe direction — it removes
 * nothing". Both halves were wrong. The nested backtick TERMINATED the outer
 * template early, desynchronising quote state and deleting real code, and the
 * original two-`replace` form had handled the same input correctly. Measured
 * against the parser: `const a = `x${ `y` }z`;` followed by a table write
 * leaves the write intact and the file exactly its original length. */
/* Parsing is correct but not free, and the callers re-ask the same question a
 * lot: the analyzer strips each closure member once per entrypoint that reaches
 * it (363 module visits over 26 entrypoints), and browser-data-plane.test.ts
 * strips every file in the tree in one `it`, which timed out at 5s the moment
 * this became a real parse. Keyed on the content as well as the name, so a
 * changed file is never answered from the cache. */
const STRIP_CACHE = new Map();

export function stripComments(src, fileName = "input.tsx") {
  const key = `${fileName}\u0000${src}`;
  const hit = STRIP_CACHE.get(key);
  if (hit !== undefined) return hit;
  const out = stripCommentsUncached(src, fileName);
  STRIP_CACHE.set(key, out);
  return out;
}

function stripCommentsUncached(src, fileName) {
  // Parsed, not lexed by hand. The hand-written scanner this replaces guessed
  // at the two hardest questions in JavaScript tokenisation and got both wrong
  // in the dangerous direction:
  //
  //   REGEX vs DIVISION. Its heuristic listed the characters a regex may follow
  //   and omitted `)`. So in `if (cond) /^https?:\/\//.test(x)` the regex was
  //   read as division, its body was copied into the code stream, and the `//`
  //   inside it was then deleted as a line comment together with the rest of
  //   the line. An auditor used exactly that to hide a call to a tombstoned
  //   routine AND a table write from the analyzer, which reported PASS. Adding
  //   `)` to the list is not a fix — `(a + b) / c` is division — the question
  //   genuinely needs a parser.
  //
  //   JSX. An apostrophe in JSX text (`<p>Don't panic</p>`) opened a string
  //   state that ran to the next `'` anywhere in the file, so code between them
  //   was treated as string content. That was a STRICT REGRESSION: the two
  //   `replace` calls this all started from handled those inputs correctly.
  //
  // TypeScript's parser answers both by construction, understands .ts/.tsx/.mts
  // and template literals, and is already a devDependency because `tsc` runs in
  // the same suite. Comments are blanked to spaces rather than removed so every
  // downstream offset and line number still lines up with the real file.
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, guessKind(fileName));
  // CODE UNITS, not code points. `Array.from(src)` splits by code point, while
  // ts.getLeading/TrailingCommentRanges return UTF-16 code-UNIT offsets — so a
  // single emoji anywhere before a comment shifted every later blanking window
  // one slot right, leaving the comment's head intact and blanking that many
  // characters of REAL CODE past its end. `join("")` then restored the UTF-16
  // length, so the length-preservation guard added in the same round could not
  // see it. Demonstrated: an emoji map above `svc.from("accounts")/*p*/.delete()`
  // produced `.d     ()` and REACHABILITY: PASS on a live route closure;
  // replacing only the emoji with ASCII flipped it to FAIL with 5 offences.
  // The converse also fired — an emoji INSIDE a comment shortened the output and
  // tripped that guard on entirely benign code.
  const blanked = src.split("");
  const seen = new Set();
  const blank = (r) => {
    const key = `${r.pos}:${r.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (let i = r.pos; i < r.end && i < blanked.length; i += 1) {
      if (blanked[i] !== "\n" && blanked[i] !== "\r") blanked[i] = " ";
    }
  };
  // Every comment is leading trivia of some token, and EndOfFileToken carries
  // any trailing comment, so walking tokens covers the file exhaustively.
  const visit = (node) => {
    const full = node.getFullStart();
    for (const r of ts.getLeadingCommentRanges(src, full) ?? []) blank(r);
    for (const r of ts.getTrailingCommentRanges(src, node.getEnd()) ?? []) blank(r);
    node.getChildren(sf).forEach(visit);
  };
  visit(sf);
  return blanked.join("");
}

/** .tsx and .jsx must be parsed as JSX; everything else as ordinary TS. */
function guessKind(fileName) {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.m?js$|\.cjs$/i.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}


/**
 * Does this module declare a Server Action?
 *
 * THE WHOLE FILE, outside comments. The action classifier used to read
 * `readFileSync(f).slice(0, 200)`, which is the same 200-byte head-of-file
 * window reachability.mjs documents as a defect it had already fixed: a banner
 * comment longer than 200 bytes above a function-level `"use server"` hid the
 * module from the classifier while the analyzer still saw it as an action.
 * Measured on a file with a 251-byte banner (measured from the fixture; an earlier note said 276): server-actions.test.ts saw no
 * action, reachability.mjs saw one — so the module escaped the permitted-action
 * table, the write-method check and the "only auth-only may construct a
 * Supabase client" check, all at once.
 *
 * Deliberately crude, and deliberately the same crudeness in both places: the
 * directive anywhere outside a comment, at file level or inside a function.
 */
export function hasUseServer(src, fileName = "input.tsx") {
  return /["']use server["']/.test(stripComments(src, fileName));
}
