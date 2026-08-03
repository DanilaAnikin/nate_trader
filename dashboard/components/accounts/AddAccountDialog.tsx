"use client";

import { useState } from "react";
import Modal from "./Modal";
import { V11_POLICY } from "@/lib/v11-policy";

const COLORS = [
  "#007aff",
  "#34c759",
  "#ff9500",
  "#af52de",
  "#5ac8fa",
  "#ff3b30",
];

type Mode = "paper" | "live";

export default function AddAccountDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [nickname, setNickname] = useState("");
  const [mode, setMode] = useState<Mode>("paper");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setNickname("");
    setMode("paper");
    setApiKey("");
    setApiSecret("");
    setColor(COLORS[0]);
    setLiveConfirmed(false);
    setError(null);
  }

  function close() {
    if (busy) return;
    reset();
    onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "live" && !liveConfirmed) {
      setError("Please confirm you understand these are LIVE-account credentials.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname, mode, apiKey, apiSecret, color }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Could not create the account.");
        return;
      }
      reset();
      onCreated();
      onClose();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Add Alpaca account">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="block text-xs text-secondary mb-1">Nickname</label>
          <input
            type="text"
            required
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="e.g. Main paper"
            className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-blue"
          />
        </div>

        <div>
          <label className="block text-xs text-secondary mb-1.5">
            Account type
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(["paper", "live"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-lg border px-3 py-2 text-sm font-medium capitalize transition-colors ${
                  mode === m
                    ? m === "live"
                      ? "border-red bg-red/10 text-red"
                      : "border-blue bg-blue/10 text-blue"
                    : "border-border text-secondary hover:bg-surface"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs text-secondary mb-1">
            Alpaca API key
          </label>
          <input
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm font-mono outline-none focus:border-blue"
          />
        </div>

        <div>
          <label className="block text-xs text-secondary mb-1">
            Alpaca API secret
          </label>
          <input
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm font-mono outline-none focus:border-blue"
          />
          <p className="text-[11px] text-muted mt-1">
            Keys are validated against Alpaca, then encrypted in Supabase Vault.
            They are never stored in plaintext.
          </p>
        </div>

        <div>
          <label className="block text-xs text-secondary mb-1.5">Color</label>
          <div className="flex gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
                style={{ backgroundColor: c }}
                className={`h-7 w-7 rounded-full transition-transform ${
                  color === c
                    ? "ring-2 ring-offset-2 ring-foreground/30 scale-110"
                    : ""
                }`}
              />
            ))}
          </div>
        </div>

        {mode === "live" && (
          <label className="flex items-start gap-2 rounded-lg bg-red/5 border border-red/20 p-3">
            <input
              type="checkbox"
              checked={liveConfirmed}
              onChange={(e) => setLiveConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-xs text-foreground">
              I understand this connects a <strong>LIVE</strong> account for
              read-only monitoring. V11 production execution remains {V11_POLICY.productionExecutionMode}
              and will not place orders on this account.
            </span>
          </label>
        )}

        {error && <p className="text-xs text-red">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded-lg border border-border px-4 py-2 text-sm text-secondary hover:bg-surface disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-blue text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? "Validating…" : "Add account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
