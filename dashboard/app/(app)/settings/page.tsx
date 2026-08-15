"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import type { SafeAccount } from "@/lib/accounts/read";
import { V11_POLICY } from "@/lib/v11-policy";

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

  const [accounts, setAccounts] = useState<SafeAccount[]>([]);
  const [defaultAccountId, setDefaultAccountId] = useState("");
  const [defaultStatus, setDefaultStatus] = useState<Status>(null);
  const [savingDefault, setSavingDefault] = useState(false);

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
      const profRes = await fetch("/api/profile", { cache: "no-store" });
      const profBody = await profRes.json().catch(() => ({ profile: null }));
      if (!active) return;
      setDisplayName(profBody.profile?.display_name ?? "");
      setDefaultAccountId(profBody.profile?.default_account_id ?? "");
      const accRes = await fetch("/api/accounts", { cache: "no-store" });
      const accBody = await accRes.json().catch(() => ({ accounts: [] }));
      if (!active) return;
      setAccounts(accBody.accounts ?? []);
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
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: displayName.trim() || null }),
      });
      if (!res.ok) throw new Error("save failed");
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

  async function saveDefault(e: React.FormEvent) {
    e.preventDefault();
    setDefaultStatus(null);
    setSavingDefault(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ default_account_id: defaultAccountId || null }),
      });
      if (!res.ok) throw new Error("save failed");
      setDefaultStatus({ kind: "ok", text: "Default account saved." });
    } catch {
      setDefaultStatus({
        kind: "err",
        text: "Could not save default account.",
      });
    } finally {
      setSavingDefault(false);
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
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-foreground mb-1">Settings</h1>
      <p className="text-sm text-muted mb-6">
        Your profile, password and default observer account. Strategy
        parameters are not editable here — they are part of the promoted
        release identity.
      </p>

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-6">
          <section className="panel p-5">
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
                  className="w-full rounded-md border border-border px-3 py-2 text-sm bg-surface text-muted"
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
                  className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-blue"
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
                className="rounded-md bg-blue text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
              >
                {savingProfile ? "Saving…" : "Save profile"}
              </button>
            </form>
          </section>

          <section className="panel p-5">
            <h2 className="text-sm font-semibold text-foreground mb-1">
              Default account
            </h2>
            <p className="text-xs text-muted mb-4">
              The account shown first when you open the dashboard.
            </p>
            <form onSubmit={saveDefault} className="space-y-3">
              <select
                value={defaultAccountId}
                onChange={(e) => setDefaultAccountId(e.target.value)}
                className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-blue bg-card"
              >
                <option value="">No default — use most recent</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nickname} ({a.mode})
                  </option>
                ))}
              </select>
              {defaultStatus && (
                <p
                  className={`text-xs ${defaultStatus.kind === "ok" ? "text-green" : "text-red"}`}
                >
                  {defaultStatus.text}
                </p>
              )}
              <button
                type="submit"
                disabled={savingDefault}
                className="rounded-md bg-blue text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
              >
                {savingDefault ? "Saving…" : "Save default"}
              </button>
            </form>
          </section>

          <section className="panel p-5">
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
                  className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-blue"
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
                  className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-blue"
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
                className="rounded-md bg-blue text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
              >
                {savingPassword ? "Updating…" : "Update password"}
              </button>
            </form>
          </section>

          <EffectivePolicySummary />
        </div>
      )}
    </div>
  );
}

/**
 * Read-only mirror of the effective V11 policy.
 *
 * Deliberately not a form: strategy parameters, universe refresh and risk
 * limits are part of the promoted release identity, and changing them from a
 * web session would invalidate the canonical validation evidence.
 */
function EffectivePolicySummary() {
  const rows: [string, string][] = [
    ["Strategy", `${V11_POLICY.displayName} (${V11_POLICY.strategyVersion})`],
    ["Execution mode", "Alpaca paper only — no supported live-money mode"],
    ["Signal", `${V11_POLICY.signal}, 6-1 momentum as tie-break only`],
    ["Weighting", `${V11_POLICY.weighting}, up to ${V11_POLICY.topN} names`],
    ["Single-name cap", `${V11_POLICY.maxPositionPct}% of equity`],
    ["Sector cap", `${V11_POLICY.maxSectorPct}% of equity`],
    ["Normal gross target", `${V11_POLICY.maxGrossExposurePct}%`],
    ["Minimum cash", `${V11_POLICY.minCashPct}%`],
    [
      "Scale-down threshold",
      `fewer than ${V11_POLICY.minEligiblePositions} eligible names`,
    ],
    [
      "Breadth scaling",
      V11_POLICY.breadthScalingEnabled
        ? "enabled (100% / 80% / 55% / 25% at 60% / 45% / 30% breadth)"
        : "disabled",
    ],
    [
      "CAUTIOUS trigger",
      `daily ${V11_POLICY.riskThresholds.dailyCautiousPct}% or rolling drawdown ${V11_POLICY.riskThresholds.rollingDrawdownCautiousPct}% → next monthly target halved`,
    ],
    [
      "HALT trigger",
      `daily ${V11_POLICY.riskThresholds.dailyHaltPct}% → zero directional target, exits only`,
    ],
    ["Market gate", "SPY must close above its 200-session SMA"],
    ["Rebalance cadence", "monthly, plus a one-shot recovery latch"],
    ["Fixed per-position stop", "none — V11 has no 8% stop"],
    [
      "Disabled sleeves",
      "SPY/SSO base, TQQQ, UPRO, SH hedge, options, mean reversion, PEAD, sector rotation, legacy score entries",
    ],
  ];

  return (
    <section className="panel p-5">
      <h2 className="text-sm font-semibold text-foreground mb-1">
        Effective V11 policy (read-only)
      </h2>
      <p className="text-xs text-muted mb-4">
        A tested display mirror of{" "}
        <code className="font-mono">scripts/strategy_config.py</code>. The
        Python policy remains the trading source of truth.
      </p>
      <dl className="text-xs">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5 border-b border-border last:border-b-0"
          >
            <dt className="text-muted shrink-0">{label}</dt>
            <dd className="text-foreground text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
