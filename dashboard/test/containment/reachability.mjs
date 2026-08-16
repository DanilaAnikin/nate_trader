#!/usr/bin/env node
/**
 * Prove that no production entrypoint can reach a routine migration 0022
 * tombstoned.
 *
 * WHY A GRAPH, NOT A GREP
 * -----------------------
 * "maintenanceBlock appears in the file" is not proof of anything. Neither is
 * "the handler returns 503 today". Both are claims about control flow, which is
 * undecidable in general and, worse, silently falsified by an ordinary
 * refactor. What IS decidable is the module graph: if a tombstoned routine is
 * not in the transitive import closure of any production entrypoint, no code
 * path through those entrypoints can call it, regardless of branching.
 *
 * WHAT THE SECOND AUDIT CHANGED
 * -----------------------------
 * An independent proof-honesty audit demonstrated eight ways this file stayed
 * green while the property it names was false, and they were all one defect:
 *
 *   it enumerated from disk, then narrowed to ONE SYNTACTIC FORM and treated
 *   every other form as ABSENT rather than as UNKNOWN.
 *
 * `import` but not `import()`. `.ts` but not `.js`. `.rpc(` but not `.rpc<T>(`.
 * A file-level directive in the first 200 bytes but not at byte 201, and not a
 * function-level one. Each narrowing turned a thing it could not see into a
 * thing it reported as safe.
 *
 * So the rule now is: anything this analyzer cannot classify is an ERROR, not
 * an absence. That is the only honest verdict available to a static tool — it
 * can say "I checked and it is not there", or "I could not check", and the
 * second must never be printed as the first.
 *
 * FAIL-CLOSED, specifically. Each of these is an error:
 *   - an import specifier that does not resolve to a file
 *   - a dynamic import() or require() whose argument is not a literal
 *   - any `.rpc` that is not a direct call with a literal name
 *   - a forbidden routine's NAME appearing as a string literal anywhere in a
 *     closure, whatever the call syntax around it
 *   - fewer entrypoints than there are route files on disk
 *   - zero entrypoints, or zero modules walked
 *
 * The alternative — skipping what it cannot understand — is how a scanner ends
 * up reporting a clean tree it never actually read.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DASH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = resolve(DASH, "..");

const errors = [];

/**
 * The tombstoned routines, READ FROM THE MIGRATION rather than retyped.
 *
 * The previous hardcoded list named three. Migration 0022 tombstones five —
 * `record_account_verification` and `create_account_atomic` as well — so the
 * file's own stated basis ("routines migration 0022 tombstones") was broader
 * than what it checked. A list that has to be kept in sync by hand will drift
 * away from the thing it describes; this one cannot.
 */
function forbiddenRoutines() {
  const dir = join(REPO, "supabase", "migrations");
  const file = existsSync(dir)
    ? readdirSync(dir).find((f) => /^0022_.*\.sql$/.test(f))
    : undefined;
  if (!file) {
    errors.push("cannot find supabase/migrations/0022_*.sql — the forbidden list has no source");
    return [];
  }
  const sql = readFileSync(join(dir, file), "utf8");

  // MECHANISM 1: the dynamic loop in section 5, driven by `p.proname in (...)`.
  const loop = sql.match(/p\.proname\s+in\s*\(([\s\S]*?)\)\s*\n/);
  const fromLoop = loop ? [...loop[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]) : [];
  if (!loop) errors.push(`cannot parse the section-5 tombstone list out of ${file}`);

  // MECHANISM 2: functions tombstoned INLINE, by a `create or replace` whose
  // body raises "is superseded".
  //
  // This exists because scoping the derivation to section 5 is not the same as
  // scoping it to the migration, and an adversarial audit proved the
  // difference: 0022 also tombstones resolve_create_operation(uuid, uuid) at
  // lines 151-168, directly, with a different message —
  // "is superseded: pass the expected request fingerprint" rather than
  // "is superseded and must not be called". Parsing one list found five names
  // where the migration tombstones six.
  //
  // The auditor found it in the catalogue classifier. It was true here too, for
  // the same reason and with the same shape: a derivation scoped to one
  // mechanism is a hand-pinned list wearing a derivation's clothes.
  // The two halves must be the SAME STATEMENT, and prose does not count.
  //
  // The first version of this scan tested "is superseded appears within 2000
  // characters" AND "raise exception appears within 2000 characters" as
  // independent conditions. It reported begin_account_verification as
  // tombstoned: its `raise exception` at offset 433 is an ordinary argument
  // check, and "is superseded" appears at offset 1706 inside a COMMENT reading
  // "this account is superseded here". Two true facts about one function, and
  // a false conclusion from their conjunction.
  //
  // So: SQL comments are stripped first — the same rule that had to be applied
  // to the browser data-plane guard today, for the same reason — and the
  // message must belong to the raise.
  const sqlNoComments = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const fromInline = [];
  const CREATE_FN = /create\s+or\s+replace\s+function\s+(?:[a-z0-9_]+\.)?([a-z0-9_]+)\s*\(/gi;
  for (const m of sqlNoComments.matchAll(CREATE_FN)) {
    // A function's body ends at its own dollar-quote terminator, NOT at the
    // next `create or replace function`.
    //
    // Slicing to the next function absorbed everything between them, and
    // section 5's tombstone loop is a `do $$ ... $$` block rather than a
    // function — so its format() string, "%s is superseded and must not be
    // called", was attributed to whichever function happened to precede it.
    // That reported audit_log_detail_guard as tombstoned. It is the guard that
    // ARMS the audit rules; treating it as superseded would have been a
    // confident, precisely-worded lie.
    const after = sqlNoComments.slice(m.index);
    const tag = after.match(/\bas\s+(\$[a-z_]*\$)/i);
    if (!tag) continue;
    const bodyStart = after.indexOf(tag[1]) + tag[1].length;
    const bodyEnd = after.indexOf(tag[1], bodyStart);
    if (bodyEnd < 0) continue;
    const body = after.slice(bodyStart, bodyEnd);
    if (/raise\s+exception\s+'[^']*is superseded/i.test(body)) {
      fromInline.push(m[1].toLowerCase());
    }
  }

  const names = [...new Set([...fromLoop, ...fromInline])].sort();

  // Non-vacuity, per mechanism. A union is only as good as its narrowest
  // contributor, and a silently-empty contributor is invisible in the total.
  if (fromLoop.length < 5) {
    errors.push(`section-5 loop yielded ${fromLoop.length} routines — expected at least 5`);
  }
  if (fromInline.length < 1) {
    errors.push(
      `the inline-tombstone scan found none in ${file} — it found resolve_create_operation when written; ` +
        `finding zero means the scan is broken, not that the migration changed`,
    );
  }
  if (!names.includes("resolve_create_operation")) {
    errors.push("resolve_create_operation is not in the derived tombstone set — the second mechanism is not working");
  }
  return names;
}

const FORBIDDEN_ROUTINES = forbiddenRoutines();

/**
 * Modules whose mere presence in an entrypoint closure is a finding, because
 * they are the mutation surface even when no routine name appears.
 *
 * DERIVED, NOT PINNED.
 *
 * This was a two-entry hardcoded list — credentials.ts and service.ts — and an
 * auditor was right to call it out: renaming or copying either one defeats it,
 * and only the routine-name rule would remain. Two adversarial audits landed on
 * the same shape the same day, in two other components: a verdict that
 * certifies a subset as whole, and an expectation catalogue naming three of the
 * five routines its own migration tombstones. A hand-pinned list is narrower
 * than the contract it claims to enforce, and nothing checks the two against
 * each other.
 *
 * So the set is computed: a module is mutation surface if it performs a
 * PostgREST TABLE WRITE. `.from("x")` followed by insert/update/upsert/delete.
 *
 * `.from(` is required in the chain deliberately. A bare `.delete(` matches
 * `cache.delete(key)` on a Map — measured, in lib/status/github-api.ts, which
 * is legitimately inside a closure and writes nothing. A rule that cannot tell
 * a Map from a table would fail this proof for a false reason, and a proof that
 * fails for false reasons gets relaxed.
 *
 * An `.rpc()` call is NOT sufficient on its own either: lib/status/broker.ts
 * calls get_account_credentials, a read, and is legitimately reachable. RPCs
 * are covered by the routine-name rule below, which is about which routine, not
 * about the call.
 *
 * A module is ALSO mutation surface if it names a tombstoned routine, because
 * that is how credentials.ts mutates — through the vault_* wrappers, never
 * through `.from()`. The first version of this derivation used table writes
 * alone and did not find it; the non-vacuity guard below caught that
 * immediately, which is the whole reason the guard is there. A derivation you
 * cannot see failing is not better than the list it replaced.
 *
 * Measured on this tree: three modules qualify — credentials.ts (tombstoned
 * RPCs), service.ts (table writes), and equity-backfill.ts (table writes),
 * which the old two-entry list MISSED.
 */
const TABLE_WRITE_RE =
  /\.from\s*\(\s*["'`][^"'`]+["'`]\s*\)[\s\S]{0,300}?\.(insert|update|upsert|delete)\s*\(/;

function forbiddenModules() {
  const found = [];
  for (const root of ["app", "lib", "components"]) {
    for (const f of walkFiles(join(DASH, root))) {
      let src;
      try {
        src = stripComments(readFileSync(f, "utf8"));
      } catch {
        errors.push(`${relative(DASH, f)}: unreadable while deriving the mutation surface`);
        continue;
      }
      const writesTable = TABLE_WRITE_RE.test(src);
      const namesTombstone = FORBIDDEN_ROUTINES.some((r) =>
        new RegExp(`["'\`]${r}["'\`]`).test(src),
      );
      if (writesTable || namesTombstone) found.push(relative(DASH, f));
    }
  }
  // Non-vacuity: a derivation that finds nothing would make the whole rule
  // silently inert, which is exactly the failure being repaired. These two are
  // known to write and must always be in the derived set; if they are not, the
  // derivation is broken rather than the tree being clean.
  for (const known of ["lib/accounts/credentials.ts", "lib/accounts/service.ts"]) {
    if (!found.includes(known)) {
      errors.push(`mutation-surface derivation did not find ${known} — the rule is not working`);
    }
  }
  return found.sort();
}

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "e2e"]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const EXT = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Every source file. `.js` and friends are included in DISCOVERY, not just in
 * resolution — the audit added `app/api/danger/route.js` with a static import
 * of the credentials module and this file reported 26 entrypoints, unchanged,
 * PASS.
 */
function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      // a dangling symlink is not "nothing here" — it is something unreadable
      errors.push(`${relative(DASH, p)}: cannot stat (dangling symlink?)`);
      continue;
    }
    if (st.isDirectory()) walkFiles(p, out);
    else if (SOURCE_RE.test(p) && !TEST_RE.test(p)) out.push(p);
  }
  return out;
}

/** Source with comments removed, so prose about a directive is not a directive. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Does this module contain a Server Action?
 *
 * Deliberately crude: the string anywhere outside a comment. The audit defeated
 * the precise version twice — once by putting a banner comment above the
 * directive so it fell past the 200-byte window, once by using a
 * function-level `"use server"` inside a page, which is the more common React
 * form and which a file-head test cannot see by construction.
 *
 * Over-inclusion costs nothing here. An extra entrypoint makes the proof
 * stricter; a missed one makes it a lie.
 */
function hasServerAction(src) {
  return /["']use server["']/.test(stripComments(src));
}

/** Production entrypoints, enumerated from disk. */
const ROUTE_FILE_RE = /\/(route|page|layout|template|error|global-error|loading|not-found|default)\.(ts|tsx|js|jsx|mjs|cjs)$/;

function entrypoints() {
  const eps = new Set();
  for (const f of walkFiles(join(DASH, "app"))) {
    if (ROUTE_FILE_RE.test(f)) eps.add(f);
  }
  for (const name of ["proxy.ts", "middleware.ts", "instrumentation.ts"]) {
    const p = join(DASH, name);
    if (existsSync(p)) eps.add(p);
  }
  // Server Actions are production entrypoints too. A "use server" module is
  // invoked by a POST to a PAGE path carrying a Next-Action header — not by
  // anything under /api — so it is reached by neither the route enumeration
  // above nor the proxy's `isApi` freeze. Whether each is ALLOWED to exist is
  // a separate, explicit judgement asserted in server-actions.test.ts.
  for (const root of ["app", "lib", "components"]) {
    for (const f of walkFiles(join(DASH, root))) {
      let src;
      try {
        src = readFileSync(f, "utf8");
      } catch {
        errors.push(`${relative(DASH, f)}: unreadable while scanning for "use server"`);
        continue;
      }
      if (hasServerAction(src)) eps.add(f);
    }
  }
  return [...eps].sort();
}

/** Resolve an import specifier to a real file, or return null (a hard error). */
function resolveSpec(spec, fromFile) {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return "EXTERNAL";
  const base = spec.startsWith("@/") ? join(DASH, spec.slice(2)) : resolve(dirname(fromFile), spec);
  for (const e of ["", ...EXT]) {
    const cand = base + e;
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  for (const e of EXT) {
    const cand = join(base, "index" + e);
    if (existsSync(cand)) return cand;
  }
  return null;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
/** `import(...)` and `require(...)`, literal or not — both are edges. */
const DYNAMIC_RE = /\b(?:import|require)\s*\(\s*([^)]*?)\s*\)/g;
/** Every mention of `.rpc`, however it is spelled. */
const RPC_ANY_RE = /\.rpc\b/g;
/** A directly classifiable call: optional generics, optional `?.`, literal name. */
const RPC_CALL_RE = /\.rpc\s*(?:<[^>]*>)?\s*\??\s*\(\s*([^,)]*)/g;

const closures = new Map();

function closureOf(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let raw;
    try {
      raw = readFileSync(f, "utf8");
    } catch {
      errors.push(`${relative(DASH, f)}: unreadable`);
      continue;
    }
    const src = stripComments(raw);
    const rel = relative(DASH, f);

    // Every `.rpc` must be a direct call with a literal name. Anything else —
    // a generic argument, an alias, a `.bind`, a computed name — is a call this
    // analyzer cannot classify, and an unclassifiable call is a hole in the
    // proof, not an absence of one. The audit reached a tombstoned routine
    // through `.rpc<void>(...)` and through `svc.rpc.bind(svc)` while this
    // printed PASS.
    const mentions = (src.match(RPC_ANY_RE) ?? []).length;
    let classified = 0;
    for (const m of src.matchAll(RPC_CALL_RE)) {
      classified += 1;
      const arg = m[1].trim();
      if (!/^["'`][a-zA-Z0-9_]+["'`]$/.test(arg)) {
        errors.push(`${rel}: .rpc() called with a non-literal name (${arg.slice(0, 40)}) — cannot be classified`);
      }
    }
    if (mentions > classified) {
      errors.push(
        `${rel}: ${mentions - classified} reference(s) to .rpc that are not a direct call ` +
          `(alias, .bind, property access) — cannot be classified`,
      );
    }

    for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        const target = resolveSpec(m[1], f);
        if (target === "EXTERNAL") continue;
        if (target === null) {
          errors.push(`${rel}: unresolved import '${m[1]}'`);
          continue;
        }
        stack.push(target);
      }
    }

    // Dynamic edges. `await import("@/lib/accounts/credentials")` is an import
    // by any reasonable reading, and following only the static form let the
    // audit put the entire credentials subgraph one `await` away from a GET
    // with the module count unchanged.
    for (const m of src.matchAll(DYNAMIC_RE)) {
      const arg = m[1].trim();
      const lit = arg.match(/^["'`]([^"'`]+)["'`]$/);
      if (!lit) {
        // an unresolvable dynamic edge could go anywhere, including here
        errors.push(`${rel}: dynamic import/require with a non-literal specifier (${arg.slice(0, 40)})`);
        continue;
      }
      const target = resolveSpec(lit[1], f);
      if (target === "EXTERNAL") continue;
      if (target === null) {
        errors.push(`${rel}: unresolved dynamic import '${lit[1]}'`);
        continue;
      }
      stack.push(target);
    }
  }
  return seen;
}

const FORBIDDEN_MODULES = forbiddenModules();

const eps = entrypoints();

// Enumeration must not silently degrade. A floor of 5 against a population of
// 26 would let four fifths of the surface vanish unnoticed, so the floor is
// derived from the disk instead of guessed: there cannot be fewer entrypoints
// than there are route files.
const routeFileCount = walkFiles(join(DASH, "app")).filter((f) => ROUTE_FILE_RE.test(f)).length;
if (eps.length < routeFileCount) {
  errors.push(`${eps.length} entrypoints but ${routeFileCount} route files on disk — enumeration is dropping files`);
}
if (eps.length === 0) errors.push("zero entrypoints discovered — enumeration is broken");
if (FORBIDDEN_ROUTINES.length === 0) errors.push("no forbidden routines — there is nothing to prove");

let modulesWalked = 0;
const offences = [];

for (const ep of eps) {
  const cl = closureOf(ep);
  closures.set(ep, cl);
  modulesWalked += cl.size;
  const rel = relative(DASH, ep);

  for (const f of cl) {
    const fr = relative(DASH, f);
    const src = stripComments(readFileSync(f, "utf8"));
    for (const routine of FORBIDDEN_ROUTINES) {
      // The NAME as a string literal, not a particular call syntax. Production
      // code has no reason to name a routine that exists only to raise. This
      // catches aliasing, dispatch tables and generics in one rule, where
      // matching `.rpc("name")` caught only the shape already thought of.
      if (new RegExp(`["'\`]${routine}["'\`]`).test(src)) {
        offences.push(`${rel} -> ${fr}: names tombstoned routine ${routine}`);
      }
    }
    for (const m of FORBIDDEN_MODULES) {
      if (fr === m) offences.push(`${rel} -> ${fr}: mutation surface in a production entrypoint closure`);
    }
  }
}

if (modulesWalked === 0) errors.push("zero modules walked — the graph walk is vacuous");

// POSITIVE CONTROL: the walker must actually be finding real edges. If the
// closure of a known route does not contain a module we know it imports, the
// resolver is broken and every "absent" above is meaningless.
const probe = eps.find((e) => e.endsWith(join("app", "api", "accounts", "route.ts")));
if (!probe) {
  errors.push("positive control: app/api/accounts/route.ts not among entrypoints");
} else if (!closures.get(probe).has(join(DASH, "lib", "accounts", "read.ts"))) {
  errors.push("positive control FAILED: accounts route closure lacks lib/accounts/read.ts — the resolver is broken");
}

console.log(`entrypoints: ${eps.length} (route files on disk: ${routeFileCount})`);
console.log(`modules walked (with repeats): ${modulesWalked}`);
console.log(`forbidden routines (read from migration 0022): ${FORBIDDEN_ROUTINES.join(", ")}`);
console.log(`mutation surface (derived: table writes + tombstoned-routine names): ${FORBIDDEN_MODULES.join(", ")}`);

if (errors.length) {
  console.error("\nFAIL-CLOSED ERRORS:");
  for (const e of errors) console.error("  " + e);
}
if (offences.length) {
  console.error("\nREACHABILITY OFFENCES:");
  for (const o of offences) console.error("  " + o);
}
if (errors.length || offences.length) {
  console.error(`\nREACHABILITY: FAIL (${errors.length} errors, ${offences.length} offences)`);
  process.exit(1);
}
console.log("\nREACHABILITY: PASS — no production entrypoint closure reaches a tombstoned routine");
