#!/usr/bin/env node
/**
 * Does the proxy actually RUN on the paths it claims to protect?
 *
 * Every existing test calls `proxy()` directly with a synthetic NextRequest.
 * Those prove the function refuses. None of them can see whether the function
 * is ever invoked — that is decided by `config.matcher`, which Next compiles
 * into a regex at build time and which no test read at all. An audit found the
 * consequence: the matcher's negative lookahead ended in `.*\.(?:svg|png|...)$`,
 * where `.*` spans the whole path, so `DELETE /api/accounts/abc.png` skipped
 * the proxy entirely while 504 tests stayed green.
 *
 * So this asserts against Next's OWN COMPILED OUTPUT — the regex in
 * .next/server/functions-config-manifest.json — not against the source string
 * and not against a reimplementation of Next's matcher compiler. A replica
 * would only prove the replica agrees with itself.
 *
 * It requires a build and FAILS if there is none. Skipping would restore
 * exactly the silence this exists to end.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DASH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = join(DASH, ".next", "server", "functions-config-manifest.json");

if (!existsSync(MANIFEST)) {
  console.error(
    `FAIL: ${MANIFEST} not found.\n` +
      "This check reads Next's compiled matcher, so it needs `next build` first.\n" +
      "It fails rather than skips: a skipped matcher check is how the extension\n" +
      "bypass shipped in the first place.",
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const entry = manifest?.functions?.["/_middleware"];
if (!entry?.matchers?.length) {
  console.error("FAIL: no /_middleware matchers in the manifest — the proxy is not wired up at all");
  process.exit(1);
}

const regexes = entry.matchers.map((m) => new RegExp(m.regexp));
const runs = (p) => regexes.some((r) => r.test(p));

// Every extension the old lookahead excluded, on a dynamic API segment — the
// exact shape of the bypass. `[id]` accepts any string, so each of these
// routes to a real handler.
const EXTS = ["svg", "png", "jpg", "jpeg", "gif", "webp", "ico"];

const MUST_RUN = [
  "/api",
  "/api/accounts",
  "/api/accounts/abc",
  "/api/profile",
  "/api/health",
  ...EXTS.map((e) => `/api/accounts/abc.${e}`),
  ...EXTS.map((e) => `/api/accounts/abc.${e.toUpperCase()}`),
  "/api/accounts/abc.png/verify",
  "/api/accounts/..%2Fabc.png",
  "/login",
  "/",
];

// The proxy must NOT be a match-everything, or "it runs on /api" is vacuous.
const MUST_SKIP = [
  "/_next/static/chunks/main.js",
  "/_next/image",
  "/favicon.ico",
  "/logo.png",
  "/assets/hero.webp",
];

let bad = 0;
for (const p of MUST_RUN) {
  if (!runs(p)) {
    console.error(`  MISS  the proxy does NOT run on ${p}`);
    bad += 1;
  }
}
for (const p of MUST_SKIP) {
  if (runs(p)) {
    console.error(`  WIDE  the proxy runs on ${p}, which should be served statically`);
    bad += 1;
  }
}

// Non-vacuity. If the matcher matched literally everything, MUST_RUN would
// pass for a reason that has nothing to do with the fix.
const anySkipped = MUST_SKIP.some((p) => !runs(p));
if (!anySkipped) {
  console.error("  VACUOUS  nothing at all is excluded — the matcher is not discriminating");
  bad += 1;
}

console.log(`matchers: ${entry.matchers.length}`);
for (const m of entry.matchers) console.log(`  ${m.originalSource}`);
console.log(`checked ${MUST_RUN.length} must-run, ${MUST_SKIP.length} must-skip`);

if (bad) {
  console.error(`\nPROXY MATCHER: FAIL (${bad} problem(s))`);
  process.exit(1);
}
console.log("\nPROXY MATCHER: PASS — the proxy runs on every API path, including extension-suffixed ones");
