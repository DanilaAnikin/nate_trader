import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";

/**
 * Supabase auth code exchange — used by email-confirmation links and any
 * future OAuth provider. Exchanges the `code` for a session, then redirects.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next");
  // Only an absolute path within this application may receive the session.
  // Concatenating an arbitrary value to origin allows `@other.example` to
  // reinterpret the dashboard host as URL credentials and leave the site.
  let destination = new URL("/", origin);
  if (next?.startsWith("/") && !next.startsWith("//")) {
    try {
      const candidate = new URL(next, origin);
      if (candidate.origin === origin) destination = candidate;
    } catch {
      // An invalid return path falls back to the overview.
    }
  }

  if (code) {
    const supa = await getSupabaseServer();
    const { error } = await supa.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(destination);
    }
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
