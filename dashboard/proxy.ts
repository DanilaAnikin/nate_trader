import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { LEGACY_DASHBOARD_ALLOWED } from "@/lib/supabase/config";

// Paths reachable without a session.
const PUBLIC_PREFIXES = ["/login", "/auth", "/api/health"];

const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const FREEZE_VALUES: ReadonlySet<string> = new Set(["on", "1", "true", "yes"]);

/**
 * The freeze flag, read here rather than imported from `lib/maintenance` so
 * this file keeps no `server-only` dependency.
 */
function maintenanceFrozen(): boolean {
  const raw = process.env.DASHBOARD_MAINTENANCE_MODE?.trim().toLowerCase();
  return raw !== undefined && FREEZE_VALUES.has(raw);
}

const SIDECAR_ONLY = (() => {
  const raw = process.env.DASHBOARD_SIDECAR_ONLY?.trim().toLowerCase();
  return raw !== undefined && FREEZE_VALUES.has(raw);
})();

/**
 * Loopback, decided from the `Host` header and the absence of proxy headers.
 *
 * `x-forwarded-*` is only ever a reason to *reject*: a request carrying one
 * came through a proxy, which is what a sidecar must not be reachable
 * through. Trusting it to prove loopback would let a caller assert its own
 * address.
 */
function requestIsLoopback(request: NextRequest): boolean {
  if (request.headers.get("x-forwarded-for") !== null) return false;
  if (request.headers.get("x-forwarded-host") !== null) return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const bare = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

/**
 * Refreshes the Supabase session cookie on every request and gates access:
 * unauthenticated users are sent to /login, signed-in users are bounced off
 * /login. API callers receive JSON errors instead of redirects. Missing auth
 * configuration fails closed unless legacy mode was explicitly enabled.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const path = request.nextUrl.pathname;
  const isApi = path === "/api" || path.startsWith("/api/");
  const isPublic = PUBLIC_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  // Sidecar isolation, before anything else. An image running as a smoke-test
  // sidecar must not be reachable by ordinary users: with the freeze off, its
  // lifecycle writes hit the real database. Enforced here so a
  // misconfiguration fails closed rather than serving the internet.
  if (SIDECAR_ONLY && !requestIsLoopback(request)) {
    return NextResponse.json(
      {
        code: "SIDECAR_ONLY",
        error:
          "This instance is running as an isolated smoke-test sidecar and only accepts loopback requests.",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (path === "/api/health") return response;

  // The write freeze, at the edge of the image and *before* authentication.
  //
  // The per-handler guards are the real control; this is the one that makes it
  // observable and total. Without it an unauthenticated write returns 401 —
  // correct, but it means the freeze cannot be verified from outside, and a
  // smoke test that cannot see a control cannot confirm it. Any mutating
  // method against the API is refused here, whoever is asking.
  //
  // Deliberately by method only. `GET /equity` must keep serving the stored
  // curve; what stops there is its *backfill*, which the handler skips (see
  // `backfillFrozen`). Blocking the read as well would blank the chart for the
  // whole maintenance window without protecting anything.
  if (isApi && MUTATING_METHODS.has(request.method) && maintenanceFrozen()) {
    return NextResponse.json(
      {
        code: "MAINTENANCE_MODE",
        error:
          "The dashboard is in maintenance mode: writes are frozen while a schema migration or rollback is in progress.",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "600" },
      },
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    if (LEGACY_DASHBOARD_ALLOWED || isPublic) return response;
    return NextResponse.json(
      { error: "Dashboard authentication is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user && !isPublic) {
      if (isApi) {
        return NextResponse.json(
          { code: "UNAUTHENTICATED", error: "Authentication is required." },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        );
      }
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      redirectUrl.search = "";
      return NextResponse.redirect(redirectUrl);
    }
    if (user && path === "/login") {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/";
      redirectUrl.search = "";
      return NextResponse.redirect(redirectUrl);
    }

    return response;
  } catch {
    // A configured financial dashboard must fail closed when its identity
    // provider is unavailable. Public login/callback paths remain reachable;
    // authenticated pages and APIs expose no fallback data.
    if (isPublic) return response;
    return NextResponse.json(
      { error: "Authentication service temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const config = {
  matcher: [
    // Everything except Next internals and static image assets.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
