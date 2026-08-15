import { type NextRequest, NextResponse } from "next/server";
import { ARTIFACT_ROLE, FROZEN_BODY } from "@/lib/frozen";
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
  // UNCONDITIONAL in this artifact. No flag, no bypass, no sidecar mode.
  //
  // This used to be gated on `maintenanceFrozen() && !bypassPossible()`, so with
  // DASHBOARD_MAINTENANCE_MODE absent the proxy fell through to
  // createServerClient() + auth.getUser() and answered 401 — before the
  // handler's constant 503 could run. The runtime canary measured exactly that:
  // 95 of 240 mutating requests returned 401 instead of 503, and a Supabase
  // client was constructed on 190 of them. The handlers were frozen; the edge
  // in front of them was not, which meant the artifact as a whole was not.
  //
  // The operator-bypass reasoning that justified the old condition belongs to a
  // dashboard that can be unfrozen. This one cannot: `lib/frozen.ts` is a
  // constant and there is no maintenance window to end. Keeping a bypass here
  // would leave a path that reaches authentication on a mutating request.
  if (isApi && MUTATING_METHODS.has(request.method)) {
    return NextResponse.json(FROZEN_BODY, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Artifact-Role": ARTIFACT_ROLE,
        "X-Writes-Enabled": "false",
      },
    });
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
