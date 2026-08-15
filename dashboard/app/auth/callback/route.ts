import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";

/**
 * Supabase auth code exchange — used by email-confirmation links and any
 * future OAuth provider. Exchanges the `code` for a session, then redirects.
 */

/**
 * Resolve `?next=` to a path on THIS origin, or fall back to the root.
 *
 * `${origin}${next}` looks like string concatenation and is actually a URL
 * parser instruction. An audit demonstrated it:
 *
 *   next="@evil.com"  ->  https://dashboard.example.com@evil.com   host: evil.com
 *   next=".evil.com"  ->  https://dashboard.example.com.evil.com   host: that
 *
 * Everything before an `@` in an authority is userinfo, so the first case
 * quietly hands the browser to the attacker's host; the second appends to the
 * hostname. The realistic vector is a crafted confirmation link whose
 * redirect_to carries the tainted `next`: the victim consumes their own valid
 * code and is then bounced off-origin. No token leaves the origin — the
 * session lands in a cookie on this domain — so the damage is phishing rather
 * than credential theft, which is why this is worth fixing quietly rather than
 * urgently.
 *
 * Two checks, because either alone has a hole. The prefix test rejects
 * anything that is not a single-slash relative path, which is what stops
 * `@evil.com` (no leading slash), `//evil.com` and `/\evil.com` (protocol-
 * relative, and the backslash form some parsers treat as one). Parsing then
 * confirms the result actually stayed here, which is the property we want
 * rather than a proxy for it — a rule that only pattern-matches is a bet that
 * the pattern list is complete, and this is the second time that bet has been
 * lost in this artifact today.
 */
export function safeNext(raw: string | null, origin: string): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"), origin);

  if (code) {
    const supa = await getSupabaseServer();
    const { error } = await supa.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
