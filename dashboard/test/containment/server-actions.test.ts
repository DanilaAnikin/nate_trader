import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { hasUseServer } from "./source-scan.mjs";

/**
 * Every Server Action is explicitly classified, and none can mutate data.
 *
 * WHY THIS EXISTS
 * ---------------
 * An adversarial verifier found that the containment harness claimed to drive
 * "every mutating method" while three `"use server"` modules sat outside the
 * surface entirely. A Server Action is invoked by a POST to a PAGE path
 * carrying a `Next-Action` header — not by anything under `/api` — so it is
 * matched by neither the route enumeration nor the proxy's `isApi` freeze.
 *
 * The fix is NOT to freeze them. `signOut()` must keep working: Stage 1 of the
 * cutover explicitly verifies logout, and the Auth-only edge is designed to
 * permit exactly that. Freezing it would break the one flow containment is
 * meant to preserve.
 *
 * The fix is to stop the claim being silently narrow. Each action is
 * enumerated FROM DISK, classified with a written justification, and asserted
 * to reach no mutation surface. A new, unclassified action fails this test —
 * which is the property that matters, because the danger is not these three,
 * it is the fourth one somebody adds later.
 */

const DASH = join(__dirname, "..", "..");
const SKIP = new Set(["node_modules", ".next", "dist", "e2e"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    // SIX EXTENSIONS, the same set reachability.mjs walks. This accepted only
    // .ts and .tsx, so a `"use server"` module written as .mjs, .js, .jsx or
    // .cjs was invisible to the action classifier while the analyzer next door
    // saw it — a third enumerator carrying the blind spot two others had just
    // been widened to remove, in a file the same commit was already editing.
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p) && !/\.test\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p)) out.push(p);
  }
  return out;
}

/** Every `"use server"` module, found rather than listed. */
const ACTION_FILES = ["app", "lib", "components"]
  .flatMap((r) => walk(join(DASH, r)))
  .filter((f) => hasUseServer(readFileSync(f, "utf8"), f))
  .map((f) => relative(DASH, f))
  .sort();

/**
 * The classification. Each entry says what the action is permitted to do and
 * why that is compatible with a frozen containment bridge. Adding an action
 * without adding a row here fails the test below.
 */
const CLASSIFIED: Record<string, { kind: string; why: string }> = {
  "app/actions.ts": {
    kind: "cache-only",
    why: "refreshAll() calls revalidatePath() and returns a timestamp. It touches the Next.js cache and nothing else — no database, no Vault, no broker, no Supabase client.",
  },
  "app/auth/actions.ts": {
    kind: "auth-only",
    why: "signOut() ends the session via supabase.auth.signOut() and redirects. It constructs a Supabase client, but only for GoTrue — the one surface the Auth-only edge deliberately keeps open, and the flow Stage 1 verifies. Freezing it would break logout.",
  },
  "lib/account-actions.ts": {
    kind: "cookie-only",
    why: "selectAccount() writes an httpOnly cookie recording which account to display. Ownership is revalidated on READ by getSelectedAccount(), so an arbitrary value here cannot surface another user's account. No database write.",
  },
};

/** Nothing a Server Action may reach, whatever its classification. */
const FORBIDDEN = [
  "vault_create_secret",
  "vault_update_secret",
  "vault_delete_secret",
  "@/lib/accounts/service",
  "@/lib/accounts/credentials",
  "./credentials",
];

describe("the Server Action surface is enumerated and classified", () => {
  it("found the action modules", () => {
    // non-vacuity: a walker that returned nothing would make every check below
    // trivially true, which is exactly how this surface went unnoticed before
    expect(ACTION_FILES.length).toBeGreaterThan(0);
  });

  it("every action module is explicitly classified", () => {
    const unclassified = ACTION_FILES.filter((f) => !(f in CLASSIFIED));
    expect(
      unclassified,
      "a new Server Action was added without classifying what it is permitted to do",
    ).toEqual([]);
  });

  it("no classification is stale", () => {
    // a row for a file that no longer exists is a rule nobody is enforcing
    const stale = Object.keys(CLASSIFIED).filter((f) => !ACTION_FILES.includes(f));
    expect(stale).toEqual([]);
  });

  it("no action reaches a tombstoned routine or the mutation surface", () => {
    const offences: string[] = [];
    for (const f of ACTION_FILES) {
      const code = readFileSync(join(DASH, f), "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
        .join("\n");
      for (const bad of FORBIDDEN) {
        if (code.includes(bad)) offences.push(`${f}: references ${bad}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("no action performs a database write", () => {
    // `.from(...).insert/update/upsert/delete` and `.rpc(` are the shapes that
    // would make one of these a data mutation rather than cache/auth/cookie
    const offences: string[] = [];
    for (const f of ACTION_FILES) {
      const code = readFileSync(join(DASH, f), "utf8");
      if (/\.(insert|update|upsert|delete)\s*\(/.test(code)) offences.push(`${f}: performs a table write`);
      if (/\.rpc\s*\(/.test(code)) offences.push(`${f}: calls an RPC`);
    }
    expect(offences).toEqual([]);
  });

  it("only the auth-only action may construct a Supabase client", () => {
    const offences: string[] = [];
    for (const f of ACTION_FILES) {
      const code = readFileSync(join(DASH, f), "utf8");
      const constructs = /getSupabaseServer|getSupabaseService|createServerClient/.test(code);
      if (constructs && CLASSIFIED[f]?.kind !== "auth-only") {
        offences.push(`${f} is classified ${CLASSIFIED[f]?.kind} but constructs a Supabase client`);
      }
    }
    expect(offences).toEqual([]);
  });
});

describe("the action classifier reads the whole file", () => {
  /**
   * The classifier used to test `readFileSync(f).slice(0, 200)` — the same
   * 200-byte head-of-file window `reachability.mjs` documents as a defect it
   * had already fixed once. A banner comment longer than 200 bytes above a
   * function-level `"use server"` hid the module from this file's permitted-
   * action table, from its write-method check, and from its "only auth-only
   * may construct a Supabase client" check, all at once — while the analyzer
   * next door still classified it as an action.
   *
   * The two halves of this test are the red-before and the green-after,
   * executed side by side rather than described.
   */
  const BANNER_ACTION =
    "/".concat("*\n") +
    " * ".concat("x".repeat(240), "\n") +
    " */\n" +
    "export async function hidden() {\n" +
    '  "use server";\n' +
    "  return 1;\n" +
    "}\n";

  it("the 200-byte window this replaced could not see a banner-shifted directive", () => {
    // The old predicate, verbatim, as the control.
    const old = /^\s*["']use server["']/m.test(BANNER_ACTION.slice(0, 200));
    expect(old, "the old rule would have caught this — the fixture is not the attack shape").toBe(false);
    expect(BANNER_ACTION.length).toBeGreaterThan(200);
  });

  it("the whole-file rule does see it", () => {
    expect(hasUseServer(BANNER_ACTION)).toBe(true);
  });

  it("and still does not mistake prose for a directive", () => {
    // Non-vacuity in the other direction: a rule that answered `true` for
    // everything would pass the case above and be worthless.
    expect(hasUseServer('// this module is not a "use server" module\nexport const a = 1;\n')).toBe(false);
    expect(hasUseServer('/* "use server" appears here only in prose */\nexport const b = 2;\n')).toBe(false);
    expect(hasUseServer("export const c = 3;\n")).toBe(false);
  });
});
