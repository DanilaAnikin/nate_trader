"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

const SUPABASE_CONFIGURED =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

type Status = { kind: "ok" | "err"; text: string } | null;

export default function SettingsPage() {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [profileStatus, setProfileStatus] = useState<Status>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passwordStatus, setPasswordStatus] = useState<Status>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (!SUPABASE_CONFIGURED) return;
    let active = true;
    (async () => {
      const supabase = getSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!active) return;
      if (!user) {
        setLoading(false);
        return;
      }
      setEmail(user.email ?? "");
      const { data } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", user.id)
        .single();
      if (!active) return;
      setDisplayName(data?.display_name ?? "");
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileStatus(null);
    setSavingProfile(true);
    try {
      const supabase = getSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("not signed in");
      const { error } = await supabase
        .from("profiles")
        .update({ display_name: displayName.trim() || null })
        .eq("id", user.id);
      if (error) throw error;
      setProfileStatus({ kind: "ok", text: "Profile saved." });
    } catch {
      setProfileStatus({ kind: "err", text: "Could not save profile." });
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordStatus(null);
    if (password.length < 8) {
      setPasswordStatus({
        kind: "err",
        text: "Password must be at least 8 characters.",
      });
      return;
    }
    if (password !== confirm) {
      setPasswordStatus({ kind: "err", text: "Passwords do not match." });
      return;
    }
    setSavingPassword(true);
    try {
      const supabase = getSupabaseBrowser();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setPassword("");
      setConfirm("");
      setPasswordStatus({ kind: "ok", text: "Password updated." });
    } catch {
      setPasswordStatus({ kind: "err", text: "Could not update password." });
    } finally {
      setSavingPassword(false);
    }
  }

  if (!SUPABASE_CONFIGURED) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-foreground mb-1">Settings</h1>
        <p className="text-sm text-muted">
          Settings require Supabase to be configured.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-lg">
      <h1 className="text-xl font-semibold text-foreground mb-1">Settings</h1>
      <p className="text-sm text-muted mb-6">
        Manage your account and credentials.
      </p>

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-6">
          <section className="bg-white border border-border rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-foreground mb-4">
              Profile
            </h2>
            <form onSubmit={saveProfile} className="space-y-3">
              <div>
                <label className="block text-xs text-secondary mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  disabled
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm bg-surface text-muted"
                />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">
                  Display name
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-blue"
                />
              </div>
              {profileStatus && (
                <p
                  className={`text-xs ${profileStatus.kind === "ok" ? "text-green" : "text-red"}`}
                >
                  {profileStatus.text}
                </p>
              )}
              <button
                type="submit"
                disabled={savingProfile}
                className="rounded-lg bg-blue text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
              >
                {savingProfile ? "Saving…" : "Save profile"}
              </button>
            </form>
          </section>

          <section className="bg-white border border-border rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-foreground mb-4">
              Change password
            </h2>
            <form onSubmit={changePassword} className="space-y-3">
              <div>
                <label className="block text-xs text-secondary mb-1">
                  New password
                </label>
                <input
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-blue"
                />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">
                  Confirm password
                </label>
                <input
                  type="password"
                  value={confirm}
                  autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-blue"
                />
              </div>
              {passwordStatus && (
                <p
                  className={`text-xs ${passwordStatus.kind === "ok" ? "text-green" : "text-red"}`}
                >
                  {passwordStatus.text}
                </p>
              )}
              <button
                type="submit"
                disabled={savingPassword}
                className="rounded-lg bg-blue text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
              >
                {savingPassword ? "Updating…" : "Update password"}
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
