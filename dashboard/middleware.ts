import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Paths reachable without a session.
const PUBLIC_PREFIXES = ["/login", "/auth"];

/**
 * Refreshes the Supabase session cookie on every request and gates access:
 * unauthenticated users are sent to /login, signed-in users are bounced off
 * /login. If Supabase env vars are absent the middleware passes everything
 * through, so the dashboard keeps working before the environment is wired up.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return response;

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
    const path = request.nextUrl.pathname;
    const isPublic = PUBLIC_PREFIXES.some(
      (p) => path === p || path.startsWith(`${p}/`),
    );

    if (!user && !isPublic) {
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
    // Supabase is configured but unreachable (e.g. the free-tier project
    // auto-paused after inactivity). Pass the request through instead of
    // letting `fetch failed` bubble up — otherwise every gated route 504s.
    // The page layer degrades to legacy mode on the same outage.
    return response;
  }
}

export const config = {
  matcher: [
    // Everything except Next internals and static image assets.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
