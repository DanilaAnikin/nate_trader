import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { maintenanceBlock } from "@/lib/maintenance";
import {
  getAuthCookieName,
  getSupabaseServerUrl,
  LEGACY_DASHBOARD_ALLOWED,
} from "@/lib/supabase/config";

// Paths reachable without a session.
const PUBLIC_PREFIXES = ["/login", "/auth", "/api/health"];

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
  if (path === "/api/health") return response;

  // Refuse data mutations before identity-provider calls, including when the
  // database/Auth service is unavailable during a migration. Route handlers
  // repeat the guard so direct invocation cannot bypass the freeze.
  if (isApi && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    const frozen = maintenanceBlock();
    if (frozen) return frozen;
  }

  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let url: string;
  let cookieName: string;
  try {
    url = getSupabaseServerUrl();
    cookieName = getAuthCookieName();
    if (!anon) throw new Error("Missing anon key");
  } catch {
    if (LEGACY_DASHBOARD_ALLOWED || isPublic) return response;
    return NextResponse.json(
      { error: "Dashboard authentication is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const withCookies = (result: NextResponse) => {
    for (const cookie of response.cookies.getAll()) result.cookies.set(cookie);
    return result;
  };

  const supabase = createServerClient(url, anon!, {
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
        return withCookies(NextResponse.json(
          { code: "UNAUTHENTICATED", error: "Authentication is required." },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        ));
      }
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      redirectUrl.search = "";
      return withCookies(NextResponse.redirect(redirectUrl));
    }
    if (user && path === "/login") {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/";
      redirectUrl.search = "";
      return withCookies(NextResponse.redirect(redirectUrl));
    }

    return response;
  } catch {
    // A configured financial dashboard must fail closed when its identity
    // provider is unavailable. Public login/callback paths remain reachable;
    // authenticated pages and APIs expose no fallback data.
    if (isPublic) return response;
    return withCookies(NextResponse.json(
      { error: "Authentication service temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    ));
  }
}

export const config = {
  matcher: [
    // Dynamic API identifiers can end in image extensions; always authenticate them.
    "/api/:path*",
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
