import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Every `"use server"` module, found rather than listed. */
const ACTION_FILES = ["app", "lib", "components"]
  .flatMap((r) => walk(join(DASH, r)))
  .filter((f) => /^\s*["']use server["']/m.test(readFileSync(f, "utf8").slice(0, 200)))
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
