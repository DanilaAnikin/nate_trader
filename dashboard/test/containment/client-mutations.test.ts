import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "./source-scan.mjs";

/**
 * What the browser is allowed to do directly, and why the freeze cannot see it.
 *
 * WHY THIS EXISTS
 * ---------------
 * An audit pointed out that `app/(app)/settings/page.tsx` calls
 * `supabase.auth.updateUser({ password })` from the BROWSER, straight at the
 * public Supabase origin. Neither the proxy nor any handler is in that path —
 * the request never touches this image. It is a real state mutation that the
 * containment freeze is structurally incapable of refusing.
 *
 * That is defensible, and it is the same judgement already made for
 * `signOut()`: the Auth surface stays open on purpose, because Stage 2's edge
 * allows exactly /auth/v1 and login has to keep working. But `lib/frozen.ts`
 * stated the property as "this image performs no writes" with no qualification,
 * and an unqualified claim that is true of the image and false of the product
 * is the kind of thing that gets repeated in a report.
 *
 * So the browser's direct surface is enumerated and classified like every
 * other one. The bound that matters is not "no writes" — it is that everything
 * the browser can do directly is GoTrue, and therefore inside the surface the
 * containment design deliberately keeps open and Stage 2 deliberately allows.
 * A client component that reached `.from()` or `.rpc()` would be outside every
 * control in this artifact, and that is what this fails on.
 */

const DASH = join(__dirname, "..", "..");
const SKIP = new Set(["node_modules", ".next", "dist", "e2e"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

// stripComments is imported: it used to be a local copy of the same two
// `replace` calls the analyzer had, and when a regex literal was shown to
// defeat that form, every copy had the hole. One definition, in source-scan.mjs.

/** Every `"use client"` module. Found, not listed. */
const CLIENT_FILES = ["app", "components", "lib"]
  .flatMap((r) => walk(join(DASH, r)))
  .filter((f) => /^\s*["']use client["']/m.test(stripComments(readFileSync(f, "utf8"), f)))
  .map((f) => relative(DASH, f))
  .sort();

/** Those that reach Supabase at all. */
const CLIENT_SUPABASE = CLIENT_FILES.filter((f) =>
  /supabase\.|createBrowserClient|getSupabaseBrowser/.test(stripComments(readFileSync(join(DASH, f), "utf8"), f)),
);

const CLASSIFIED: Record<string, { calls: string[]; why: string }> = {
  "app/login/page.tsx": {
    calls: ["auth.signInWithPassword"],
    why: "Establishing a session. This is the flow the entire containment design exists to preserve — Stage 2's edge allows /auth/v1 precisely so this keeps working — and it cannot be routed through the frozen image without the image holding credentials.",
  },
  "app/(app)/settings/page.tsx": {
    calls: ["auth.updateUser"],
    why: "A password change, browser to GoTrue. Outside the freeze by construction: the request does not touch this image. It mutates the identity provider's own record, not application data, and it is inside the Auth surface Stage 2 keeps open. Named here because the freeze cannot refuse it and an unqualified 'no writes' claim would be wrong.",
  },
};

/** Never permitted from the browser, whatever the classification says. */
const FORBIDDEN_CLIENT_CALLS = [
  ".from(",
  ".rpc(",
  "auth.admin",
  "SUPABASE_SERVICE_ROLE",
  "service_role",
];

describe("the browser's direct Supabase surface is enumerated and classified", () => {
  it("found client modules that reach Supabase", () => {
    // non-vacuity: if the walker found nothing, every rule below is trivial
    expect(CLIENT_SUPABASE.length).toBeGreaterThan(0);
  });

  it("every one is classified", () => {
    const unclassified = CLIENT_SUPABASE.filter((f) => !(f in CLASSIFIED));
    expect(
      unclassified,
      "a client component talks to Supabase directly and nothing says what it is allowed to do — no layer of the freeze can see this traffic",
    ).toEqual([]);
  });

  it("no classification is stale", () => {
    expect(Object.keys(CLASSIFIED).filter((f) => !CLIENT_SUPABASE.includes(f))).toEqual([]);
  });

  it("nothing in the browser reaches data or admin APIs", () => {
    // The real bound. Auth from the browser is a decision; a table read or an
    // RPC from the browser would be outside every control this artifact has.
    const offences: string[] = [];
    for (const f of CLIENT_SUPABASE) {
      const src = stripComments(readFileSync(join(DASH, f), "utf8"), f);
      for (const bad of FORBIDDEN_CLIENT_CALLS) {
        if (src.includes(bad)) offences.push(`${f}: uses ${bad} from the browser`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("each module makes only the Auth calls its classification names", () => {
    const AUTH_CALLS =
      /auth\.(signInWithPassword|signInWithOtp|signInWithOAuth|signUp|signOut|updateUser|resetPasswordForEmail|verifyOtp|setSession|refreshSession|exchangeCodeForSession|getUser|getSession|onAuthStateChange)/g;
    const offences: string[] = [];
    for (const f of CLIENT_SUPABASE) {
      const src = stripComments(readFileSync(join(DASH, f), "utf8"), f);
      const allowed = CLASSIFIED[f]?.calls ?? [];
      // reads are always fine; only state-changing Auth calls need naming
      const READS = ["auth.getUser", "auth.getSession", "auth.onAuthStateChange", "auth.signOut"];
      for (const m of src.matchAll(AUTH_CALLS)) {
        const call = m[0];
        if (READS.includes(call)) continue;
        if (!allowed.includes(call)) {
          offences.push(`${f}: calls ${call}, which its classification does not name`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
