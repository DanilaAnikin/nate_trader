"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

const SUPABASE_CONFIGURED =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const supabase = getSupabaseBrowser();
      if (mode === "signin") {
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
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) {
          setError(error.message);
          return;
        }
        if (data.session) {
          router.push("/");
          router.refresh();
        } else {
          setNotice(
            "Account created. Check your email to confirm, then sign in.",
          );
          setMode("signin");
        }
      }
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
            >
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
              <polyline points="16 7 22 7 22 13" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-semibold text-foreground">
              Nate Trader
            </h1>
            <p className="text-[11px] text-muted">Autonomous Agent</p>
          </div>
        </div>

        <div className="bg-white border border-border rounded-2xl p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-foreground mb-1">
            {mode === "signin" ? "Sign in" : "Create your account"}
          </h2>
          <p className="text-xs text-muted mb-5">
            {mode === "signin"
              ? "Access the trading dashboard."
              : "Sign up to manage your trading accounts."}
          </p>

          {!SUPABASE_CONFIGURED && (
            <div className="mb-4 text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2">
              Authentication is not configured yet. Set the Supabase
              environment variables to enable sign-in.
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="block text-xs text-secondary mb-1">Email</label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-blue"
              />
            </div>
            <div>
              <label className="block text-xs text-secondary mb-1">
                Password
              </label>
              <input
                type="password"
                required
                minLength={8}
                autoComplete={
                  mode === "signin" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-blue"
              />
            </div>

            {error && <p className="text-xs text-red">{error}</p>}
            {notice && <p className="text-xs text-green">{notice}</p>}

            <button
              type="submit"
              disabled={busy || !SUPABASE_CONFIGURED}
              className="w-full rounded-lg bg-blue text-white text-sm font-medium py-2 disabled:opacity-50 transition-opacity"
            >
              {busy
                ? "Please wait…"
                : mode === "signin"
                  ? "Sign in"
                  : "Sign up"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setNotice(null);
            }}
            className="mt-4 text-xs text-blue hover:underline"
          >
            {mode === "signin"
              ? "Need an account? Sign up"
              : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}
