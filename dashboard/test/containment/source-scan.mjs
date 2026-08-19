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
 * This walks the source once, treating '…', "…", `…` and /…/ as opaque and
 * removing only real comments. KNOWN LIMIT: a template literal whose `${}`
 * interpolation itself contains a backtick is consumed as one literal. That is
 * conservative in the safe direction — it removes nothing — and no file in this
 * tree does it. */
export function stripComments(src) {
  const REGEX_MAY_FOLLOW = /[=(,:[!&|?{};+\-*%^~<>]$|\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;
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
        else if (src[i] === "\n") break;              // an unterminated regex is not one
        out += src[i]; i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}


/**
 * Does this module declare a Server Action?
 *
 * THE WHOLE FILE, outside comments. The action classifier used to read
 * `readFileSync(f).slice(0, 200)`, which is the same 200-byte head-of-file
 * window reachability.mjs documents as a defect it had already fixed: a banner
 * comment longer than 200 bytes above a function-level `"use server"` hid the
 * module from the classifier while the analyzer still saw it as an action.
 * Measured on a file with a 276-byte banner: server-actions.test.ts saw no
 * action, reachability.mjs saw one — so the module escaped the permitted-action
 * table, the write-method check and the "only auth-only may construct a
 * Supabase client" check, all at once.
 *
 * Deliberately crude, and deliberately the same crudeness in both places: the
 * directive anywhere outside a comment, at file level or inside a function.
 */
export function hasUseServer(src) {
  return /["']use server["']/.test(stripComments(src));
}
