import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every Route Handler in the app, in every form it can be written, everywhere
 * it can live.
 *
 * WHY THIS EXISTS ALONGSIDE permanent-freeze.test.ts
 * --------------------------------------------------
 * That suite and app/api/route-surface.test.ts both key on the literal string
 * `export async function <VERB>`, and both `continue`/`return` when the pattern
 * does not match. An audit demonstrated the consequence with a handler that is
 * perfectly valid Next.js:
 *
 *     export const POST = async (req: Request): Promise<Response> => {
 *       const body = await req.json();
 *       await getSupabaseService().from("accounts").insert(body);
 *       return new Response("{}", { status: 200 });
 *     };
 *
 * Both enumerators reported ZERO offences. A handler that reads the body,
 * builds a service-role client and inserts a row was simply invisible: not
 * approved, not rejected, not seen. They also matched only files named exactly
 * `route.ts`, and rooted only at `app/api`, so `route.js` and anything outside
 * the API tree were equally invisible.
 *
 * The fix is not another pattern. Patterns enumerate what you thought of. This
 * inverts the burden: find handlers by ANY export form, then require each
 * mutating one to be in the single canonical shape the strict assertions can
 * actually verify. Anything else is an offence for being unverifiable, which
 * is the honest verdict — the harness is saying "I cannot check this", not
 * "this is fine".
 */

const DASH = join(__dirname, "..", "..");
const APP = join(DASH, "app");

const HTTP_VERBS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** Every Route Handler file, whatever it is called. */
function routeFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (/^route\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e)) out.push(p);
  }
  return out.sort();
}

const FILES = routeFiles(APP).map((f) => relative(DASH, f));

/** Source with comments stripped, so prose about a handler is not a handler. */
function code(rel: string): string {
  return readFileSync(join(DASH, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every way a module can export a handler named VERB. The canonical form is
 * listed separately because it is the only one the strict body assertions in
 * permanent-freeze.test.ts can read.
 */
function exportForms(src: string, verb: string) {
  return {
    canonical: new RegExp(`export\\s+async\\s+function\\s+${verb}\\s*\\(`).test(src),
    other:
      new RegExp(`export\\s+function\\s+${verb}\\s*\\(`).test(src) ||
      new RegExp(`export\\s+(?:const|let|var)\\s+${verb}\\b`).test(src) ||
      new RegExp(`export\\s*\\{[^}]*\\b${verb}\\b[^}]*\\}`).test(src) ||
      new RegExp(`export\\s*\\{[^}]*\\bas\\s+${verb}\\b`).test(src),
  };
}

/**
 * Route Handlers outside app/api. The proxy's freeze keys on /api, and both
 * older enumerators rooted at app/api, so anything here is covered by nothing
 * unless it is named and justified.
 */
const NON_API_ALLOWED: Record<string, { verbs: string[]; why: string }> = {
  "app/auth/callback/route.ts": {
    verbs: ["GET"],
    why: "The OAuth/magic-link landing. It must stay reachable unauthenticated — it is how a session is established — and it is GET-only: it exchanges a code for a session and redirects. Outside the freeze by design, because the freeze is about writes and this writes no application data.",
  },
};

describe("the Route Handler surface is completely enumerated", () => {
  it("found route files", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(8);
  });

  it("searches every route filename, not just route.ts", () => {
    // Guards the enumerator itself: if this regex is ever narrowed back to
    // `route.ts`, a route.js becomes invisible again and nothing else notices.
    expect(/^route\.\(ts\|tsx\|js\|jsx\|mjs\|cjs\)\$/.source).toBeTruthy();
    const found = FILES.filter((f) => /route\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
    expect(found.length).toBe(FILES.length);
  });

  it("every mutating handler is in the one form the strict assertions can verify", () => {
    const offences: string[] = [];
    for (const f of FILES) {
      const src = code(f);
      for (const verb of MUTATING) {
        const { canonical, other } = exportForms(src, verb);
        if (other && !canonical) {
          offences.push(
            `${f}: ${verb} is exported in a form this harness cannot verify ` +
              `(arrow/const/re-export). The body and parameter assertions read ` +
              `\`export async function ${verb}\` only, so this handler would be unaudited.`,
          );
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("no route file exports a mutating handler this suite did not see", () => {
    // Cross-check against a deliberately dumb signal: the literal verb name
    // appearing after `export`. If that finds a verb the form-parser missed,
    // the parser is the thing that is wrong.
    const offences: string[] = [];
    for (const f of FILES) {
      const src = code(f);
      for (const verb of HTTP_VERBS) {
        const mentioned = new RegExp(`export[^\\n]*\\b${verb}\\b`).test(src);
        const { canonical, other } = exportForms(src, verb);
        if (mentioned && !canonical && !other) {
          offences.push(`${f}: '${verb}' appears in an export the form-parser did not classify`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});

describe("Route Handlers outside app/api are named and justified", () => {
  const nonApi = FILES.filter((f) => !f.startsWith("app/api/") && !f.includes(".test."));

  it("every one is classified", () => {
    // The freeze keys on /api. A handler outside it is frozen by no layer, so
    // its existence has to be a decision somebody wrote down.
    const unclassified = nonApi.filter((f) => !(f in NON_API_ALLOWED));
    expect(
      unclassified,
      "a Route Handler outside app/api is covered by neither the proxy freeze nor the API enumerators",
    ).toEqual([]);
  });

  it("no classification is stale", () => {
    expect(Object.keys(NON_API_ALLOWED).filter((f) => !nonApi.includes(f))).toEqual([]);
  });

  it("each exports only the verbs its classification allows", () => {
    const offences: string[] = [];
    for (const f of nonApi) {
      const allowed = NON_API_ALLOWED[f];
      if (!allowed) continue;
      const src = code(f);
      for (const verb of HTTP_VERBS) {
        const { canonical, other } = exportForms(src, verb);
        if ((canonical || other) && !allowed.verbs.includes(verb)) {
          offences.push(`${f}: exports ${verb}, which its classification does not allow`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
