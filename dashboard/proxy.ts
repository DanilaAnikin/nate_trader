import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import {
  getAuthCookieName,
  getSupabaseServerUrl,
  LEGACY_DASHBOARD_ALLOWED,
} from "@/lib/supabase/config";

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

/**
 * True when this image may be carrying an operator freeze bypass.
 *
 * The proxy cannot evaluate the bypass — it has no authenticated user at the
 * point the freeze is checked. What it can do is decline to answer *for* the
 * handler: when the image is an isolated sidecar with a non-empty allowlist,
 * the freeze decision belongs to `maintenanceBlock(userId)` inside the
 * authenticated handler, and refusing here would make the bypass unreachable
 * no matter who was asking.
 *
 * Read at request time rather than module load so a test (and an operator
 * restarting with a new allowlist) sees the current value.
 */
function bypassPossible(): boolean {
  const sidecar = process.env.DASHBOARD_SIDECAR_ONLY?.trim().toLowerCase();
  if (sidecar === undefined || !FREEZE_VALUES.has(sidecar)) return false;
  const allowlist = process.env.DASHBOARD_FREEZE_BYPASS_USERS?.trim();
  return Boolean(allowlist);
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
  // There is deliberately no host-based sidecar check here.
  //
  // The previous one decided "is this loopback?" from the `Host` header, which
  // the caller chooses: anything that could reach the port could send
  // `Host: localhost`, so it refused honest remote clients and admitted the
  // one attacker it was written for. A sidecar's isolation comes from binding
  // the published port to 127.0.0.1, the host firewall, and an operator
  // tunnel — none of which an application can observe from a request. See
  // `lib/isolated-smoke.ts`.

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
  // ...unless an operator bypass could apply. The proxy has no authenticated
  // user here, so it must not answer for the handler: refusing at the edge
  // would make the bypass unreachable for the one session it exists for.
  // `maintenanceBlock(userId)` in the handler is the decision point, and it
  // still refuses everyone not on the list.
  if (
    isApi &&
    MUTATING_METHODS.has(request.method) &&
    maintenanceFrozen() &&
    !bypassPossible()
  ) {
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

  // The proxy validates sessions server-side, so it reads Supabase over the
  // internal network like every other server path, and pins the same cookie
  // name the browser writes. A missing internal URL is treated exactly like
  // missing auth configuration: fail closed.
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let url: string;
  let cookieName: string;
  try {
    url = getSupabaseServerUrl();
    cookieName = getAuthCookieName();
  } catch {
    if (LEGACY_DASHBOARD_ALLOWED || isPublic) return response;
    return NextResponse.json(
      { error: "Dashboard authentication is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!anon) {
    if (LEGACY_DASHBOARD_ALLOWED || isPublic) return response;
    return NextResponse.json(
      { error: "Dashboard authentication is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const supabase = createServerClient(url, anon, {
    cookieOptions: { name: cookieName },
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
