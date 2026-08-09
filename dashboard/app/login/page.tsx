"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase/client";

const SUPABASE_CONFIGURED =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Sign-in only.
 *
 * This dashboard has no public registration: it observes one production
 * trading account, and every extra tenant is only additional exposure. Public
 * sign-ups must also be disabled in the Supabase project itself — removing the
 * button is a UI change, not an authorization boundary. Access to the private
 * production runtime is separately gated server-side by
 * `PRODUCTION_OWNER_USER_ID`, so even a signed-up user sees nothing of it.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const supabase = getSupabaseBrowser();
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        // Deliberately generic — no account-existence enumeration.
        setError("Invalid email or password.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-8 justify-center">
          <div className="h-9 w-9 rounded-xl bg-blue/10 flex items-center justify-center">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent-blue)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
              <polyline points="16 7 22 7 22 13" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-semibold text-foreground">
              Nate Trader
            </h1>
            <p className="text-[11px] text-muted">
              V11 read-only observability
            </p>
          </div>
        </div>

        <div className="panel p-6">
          <h2 className="text-sm font-semibold text-foreground mb-1">Sign in</h2>
          <p className="text-xs text-muted mb-5">
            Access is by invitation. This dashboard does not offer public
            registration.
          </p>

          {!SUPABASE_CONFIGURED && (
            <div
              className="mb-4 text-xs rounded-md px-3 py-2"
              style={{
                background: "var(--tint-amber)",
                color: "var(--accent-amber)",
              }}
            >
              Authentication is not configured yet. Set the Supabase environment
              variables to enable sign-in.
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label
                htmlFor="login-email"
                className="block text-xs text-secondary mb-1"
              >
                Email
              </label>
              <input
                id="login-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-blue"
              />
            </div>
            <div>
              <label
                htmlFor="login-password"
                className="block text-xs text-secondary mb-1"
              >
                Password
              </label>
              <input
                id="login-password"
                type="password"
                required
                minLength={8}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-blue"
              />
            </div>

            {error && (
              <p className="text-xs" style={{ color: "var(--accent-red)" }}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !SUPABASE_CONFIGURED}
              className="w-full rounded-md bg-blue text-white text-sm font-medium py-2 disabled:opacity-50"
            >
              {busy ? "Please wait…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
