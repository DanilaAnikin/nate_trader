import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A GET handler may not write. Anything.
 *
 * This is a source-level guard rather than a behavioural one, deliberately.
 * The regression it prevents has happened twice and both times it was
 * invisible from the outside: `GET /status` and `GET /live` persisted
 * `status: "auth_failed"` when Alpaca rejected the credentials, and `GET
 * /equity` and `GET /performance` republished both broker mirrors on every
 * call. Each looked like an ordinary read to every test that asserted on the
 * response body, because the write was a side effect nobody sampled.
 *
 * Three separate things are wrong with a writing read: a page that polls
 * becomes a write loop, two open tabs race each other, and the write carries
 * no user intent and no audit entry. It also makes the deployment write freeze
 * (`lib/maintenance.ts`) unenforceable, because a freeze that blocks the
 * mutating verbs still lets a dashboard left open keep writing.
 *
 * Mutating a row is `POST /api/accounts/[id]/refresh` or
 * `POST /api/accounts/[id]/verify`, both of which go through an audited RPC
 * and both of which the freeze blocks.
 */

const ROOT = join(__dirname, "accounts", "[id]");

/** Every read-only handler, and the write it must never perform again. */
const READ_ONLY_ROUTES = [
  "status",
  "live",
  "equity",
  "performance",
] as const;

/**
 * Call shapes that write. `.from(...).update(...)` is the Supabase table
 * writer; `refreshBrokerDatasets` publishes both mirrors; the lifecycle and
 * verification RPCs each mutate and audit.
 */
const WRITE_MARKERS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\.update\s*\(/, what: "a Supabase table update" },
  { pattern: /\.insert\s*\(/, what: "a Supabase table insert" },
  { pattern: /\.upsert\s*\(/, what: "a Supabase table upsert" },
  { pattern: /\.delete\s*\(/, what: "a Supabase table delete" },
  { pattern: /refreshBrokerDatasets/, what: "a broker mirror refresh" },
  { pattern: /record_account_verification/, what: "a verification write" },
  { pattern: /publish_broker_refresh/, what: "a mirror publish" },
  { pattern: /begin_broker_refresh/, what: "a refresh reservation" },
  { pattern: /create_account_atomic/, what: "an account creation" },
  { pattern: /delete_account_atomic/, what: "an account deletion" },
  { pattern: /rotate_account_credentials/, what: "a credential rotation" },
  { pattern: /update_account_metadata/, what: "a metadata update" },
  { pattern: /retract_equity_snapshot|retract_cash_flow/, what: "a retraction" },
];

/** Strip comments, so prose explaining the rule cannot trip it. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("read handlers do not write", () => {
  it.each(READ_ONLY_ROUTES)("GET /api/accounts/[id]/%s", (route) => {
    const source = code(readFileSync(join(ROOT, route, "route.ts"), "utf8"));

    // The handler is a GET, and only a GET.
    expect(source).toMatch(/export async function GET\b/);
    expect(source).not.toMatch(/export async function (POST|PATCH|PUT|DELETE)\b/);

    const found = WRITE_MARKERS.filter(({ pattern }) => pattern.test(source));
    expect(
      found.map(({ what }) => what),
      `GET /${route} performs ${found.map((f) => f.what).join(", ")}`,
    ).toEqual([]);
  });
});

describe("every mutating handler is behind the write freeze", () => {
  const MUTATING = [
    ["accounts/route.ts", "POST /api/accounts"],
    ["accounts/[id]/route.ts", "PATCH and DELETE /api/accounts/[id]"],
    ["accounts/[id]/verify/route.ts", "POST /api/accounts/[id]/verify"],
    ["accounts/[id]/refresh/route.ts", "POST /api/accounts/[id]/refresh"],
  ] as const;

  it.each(MUTATING)("%s calls maintenanceBlock()", (file, label) => {
    const source = code(readFileSync(join(__dirname, file), "utf8"));
    const handlers = source.match(/export async function (POST|PATCH|PUT|DELETE)\b/g) ?? [];
    const guards = source.match(/maintenanceBlock\(\)/g) ?? [];
    expect(handlers.length, `${label} declares no mutating handler`).toBeGreaterThan(0);
    // One guard per mutating handler: a shared import is not a control.
    expect(guards.length, `${label} guards ${guards.length} of ${handlers.length}`)
      .toBeGreaterThanOrEqual(handlers.length);
  });
});
