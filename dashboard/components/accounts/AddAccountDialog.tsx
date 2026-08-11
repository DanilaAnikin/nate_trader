"use client";

import { useEffect, useRef, useState } from "react";
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

/**
 * Where a pending create operation id lives between a lost response and the
 * retry that resolves it.
 *
 * `sessionStorage`, not `localStorage`: the id must survive a reload of *this*
 * tab and must not be shared with another one, where it would make two
 * genuinely different submissions collapse into a single account.
 */
const PENDING_OPERATION_KEY = "nt.accounts.pendingCreateOperation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readPendingOperation(): string | null {
  try {
    const stored = window.sessionStorage.getItem(PENDING_OPERATION_KEY);
    // Validated on the way out as well as in: storage is writable by anything
    // running in the tab, and a malformed value would be rejected by the
    // server anyway — better to mint a fresh id than to fail the submission.
    return stored && UUID_RE.test(stored) ? stored : null;
  } catch {
    // Storage can be unavailable (private mode, disabled cookies). Losing the
    // id degrades idempotence to what it was; it must not break creation.
    return null;
  }
}

export function writePendingOperation(operationId: string): void {
  try {
    window.sessionStorage.setItem(PENDING_OPERATION_KEY, operationId);
  } catch {
    /* see readPendingOperation */
  }
}

export function clearPendingOperation(): void {
  try {
    window.sessionStorage.removeItem(PENDING_OPERATION_KEY);
  } catch {
    /* see readPendingOperation */
  }
}

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
  /**
   * Survives re-renders, retries *and* a reload.
   *
   * A `useRef` alone survives only as long as the component is mounted. The
   * failure that most needs idempotence is the one where the answer never
   * arrives — the tab is closed, the phone sleeps, the user reloads — and a
   * ref is gone by then, so the resubmission arrives with a fresh id and
   * creates a second account for the same broker credentials. The id is
   * therefore parked in `sessionStorage`: same tab, cleared when the tab
   * closes, and never shared with another tab (which would collapse two
   * genuinely different submissions into one).
   */
  const operationIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    operationIdRef.current = readPendingOperation();
  }, [open]);

  function reset() {
    setNickname("");
    setMode("paper");
    setApiKey("");
    setApiSecret("");
    setColor(COLORS[0]);
    setLiveConfirmed(false);
    setError(null);
    // A *new* submission is a new operation. Only a retry of the same one
    // reuses the id.
    operationIdRef.current = null;
    clearPendingOperation();
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
    // One id for this submission, generated *before* the request goes out and
    // reused by every retry of it. The server binds it to a digest of the
    // payload, so a retry returns the original result and a different payload
    // under the same id is refused. A server-generated id would be fresh on
    // every retry, which is precisely when idempotency is needed.
    const operationId =
      operationIdRef.current ?? readPendingOperation() ?? crypto.randomUUID();
    operationIdRef.current = operationId;
    // Written *before* the request goes out. Parking it afterwards would leave
    // exactly the window that matters uncovered: the request that was sent and
    // whose response never came back.
    writePendingOperation(operationId);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nickname,
          mode,
          apiKey,
          apiSecret,
          color,
          operationId,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The id is kept only while the outcome is genuinely unknown. A
        // definite refusal means nothing committed, so the next attempt is a
        // new submission — and reusing a spent id for a corrected payload
        // would be refused as a conflict.
        if (body.code !== "INDETERMINATE") {
          operationIdRef.current = null;
          clearPendingOperation();
        }
        setError(body.error ?? "Could not create the account.");
        return;
      }
      reset();
      onCreated();
      onClose();
    } catch {
      // The request may have committed. The id stays parked so the retry —
      // including one after a reload — resolves the original operation instead
      // of creating a second account.
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
