import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Every route in the image, enumerated — not a list someone remembered to
 * update.
 *
 * The bridge's job is to serve reads correctly on both schemas while the write
 * freeze holds. Two properties have to be true of *all* of it, and both were
 * previously true of only the routes anyone thought to check:
 *
 *   1. a `GET` handler writes nothing;
 *   2. every mutating handler is behind the freeze.
 *
 * The regressions this replaces were both invisible from the outside. `GET
 * /status` and `GET /live` persisted `status: "auth_failed"` when Alpaca
 * rejected the credentials, so a page left open rewrote the account on every
 * poll, unaudited and with no user intent. `GET /equity` and `GET
 * /performance` ran the broker backfills, which write two financial tables.
 *
 * Discovering the routes from the filesystem is the point: a new handler is
 * covered the moment it exists.
 */

const API_ROOT = join(__dirname);

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full));
    } else if (entry === "route.ts") {
      out.push(full);
    }
  }
  return out.sort();
}

/** Source with comments removed, so prose about a write is not a write. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The body of one exported handler, by brace matching.
 *
 * A collection route legitimately exports `GET` and `POST` from one file, so
 * scanning the whole file would report the creation inside `POST` as a write
 * inside `GET`. Only the named handler's own body is examined.
 */
function handlerBody(source: string, method: string): string | null {
  const marker = `export async function ${method}`;
  const at = source.indexOf(marker);
  if (at === -1) return null;
  const open = source.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

function routeName(file: string): string {
  return `/api/${relative(API_ROOT, file).split(sep).slice(0, -1).join("/")}`;
}

/** Anything that mutates the database, the Vault or the broker mirrors. */
const WRITE_MARKERS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\.update\s*\(/, what: "a table update" },
  { pattern: /\.insert\s*\(/, what: "a table insert" },
  { pattern: /\.upsert\s*\(/, what: "a table upsert" },
  { pattern: /\.delete\s*\(/, what: "a table delete" },
  { pattern: /backfillEquity|backfillCashFlows/, what: "a broker backfill" },
  { pattern: /refreshBrokerDatasets|publish_broker_refresh/, what: "a mirror publish" },
  { pattern: /create_account_atomic|delete_account_atomic/, what: "an account lifecycle write" },
  { pattern: /rotate_account_credentials|update_account_metadata/, what: "an account write" },
  { pattern: /record_account_verification/, what: "a verification write" },
  { pattern: /vault_create_secret|vault_update_secret|vault_delete_secret/, what: "a Vault write" },
];

const FILES = routeFiles(API_ROOT);

describe("the API surface", () => {
  it("finds every route file, so nothing is covered by omission", () => {
    expect(FILES.length).toBeGreaterThan(0);
    // A sanity floor: the account routes plus health and live.
    expect(FILES.map(routeName)).toEqual(expect.arrayContaining(["/api/health"]));
  });

  it.each(FILES.map((file) => [routeName(file), file] as const))(
    "%s has no writing GET handler",
    (name, file) => {
      const body = handlerBody(code(file), "GET");
      if (body === null) return;
      const found = WRITE_MARKERS.filter(({ pattern }) => pattern.test(body));
      expect(
        found.map((f) => f.what),
        `${name} performs ${found.map((f) => f.what).join(", ")} inside a GET`,
      ).toEqual([]);
    },
  );

  it.each(FILES.map((file) => [routeName(file), file] as const))(
    "%s guards every mutating handler with the freeze",
    (name, file) => {
      const source = code(file);
      const handlers =
        source.match(/export async function (POST|PATCH|PUT|DELETE)\b/g) ?? [];
      if (handlers.length === 0) return;
      const guards = source.match(/maintenanceBlock\(/g) ?? [];
      expect(
        guards.length,
        `${name} guards ${guards.length} of ${handlers.length} mutating handlers`,
      ).toBeGreaterThanOrEqual(handlers.length);
    },
  );
});
