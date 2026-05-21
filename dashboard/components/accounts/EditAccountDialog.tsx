"use client";

import { useState } from "react";
import Modal from "./Modal";
import type { SafeAccount } from "@/lib/accounts/service";

const COLORS = [
  "#007aff",
  "#34c759",
  "#ff9500",
  "#af52de",
  "#5ac8fa",
  "#ff3b30",
];

type Note = { kind: "ok" | "err"; text: string } | null;

export default function EditAccountDialog({
  open,
  account,
  onClose,
  onChanged,
}: {
  open: boolean;
  account: SafeAccount;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [nickname, setNickname] = useState(account.nickname);
  const [color, setColor] = useState(account.color);
  const [isActive, setIsActive] = useState(account.is_active);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsNote, setDetailsNote] = useState<Note>(null);

  const [rotKey, setRotKey] = useState("");
  const [rotSecret, setRotSecret] = useState("");
  const [rotBusy, setRotBusy] = useState(false);
  const [rotNote, setRotNote] = useState<Note>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [purgeHistory, setPurgeHistory] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteNote, setDeleteNote] = useState<Note>(null);

  const anyBusy = detailsBusy || rotBusy || deleteBusy;

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    setDetailsNote(null);
    setDetailsBusy(true);
    try {
      const res = await fetch(`/api/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname, color, is_active: isActive }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDetailsNote({ kind: "err", text: body.error ?? "Update failed." });
        return;
      }
      setDetailsNote({ kind: "ok", text: "Saved." });
      onChanged();
    } catch {
      setDetailsNote({ kind: "err", text: "Network error." });
    } finally {
      setDetailsBusy(false);
    }
  }

  async function rotate(e: React.FormEvent) {
    e.preventDefault();
    setRotNote(null);
    setRotBusy(true);
    try {
      const res = await fetch(`/api/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: rotKey, apiSecret: rotSecret }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRotNote({
          kind: "err",
          text: body.error ?? "Key rotation failed.",
        });
        return;
      }
      setRotKey("");
      setRotSecret("");
      setRotNote({ kind: "ok", text: "Keys validated and rotated." });
      onChanged();
    } catch {
      setRotNote({ kind: "err", text: "Network error." });
    } finally {
      setRotBusy(false);
    }
  }

  async function remove() {
    setDeleteNote(null);
    setDeleteBusy(true);
    try {
      const res = await fetch(
        `/api/accounts/${account.id}?purgeHistory=${purgeHistory}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteNote({ kind: "err", text: body.error ?? "Delete failed." });
        return;
      }
      onChanged();
      onClose();
    } catch {
      setDeleteNote({ kind: "err", text: "Network error." });
    } finally {
      setDeleteBusy(false);
    }
  }

  function noteEl(note: Note) {
    if (!note) return null;
    return (
      <p
        className={`text-xs ${note.kind === "ok" ? "text-green" : "text-red"}`}
      >
        {note.text}
      </p>
    );
  }

  return (
    <Modal
      open={open}
      onClose={() => !anyBusy && onClose()}
      title={`Edit — ${account.nickname}`}
    >
      <div className="space-y-6">
        {/* Details */}
        <form onSubmit={saveDetails} className="space-y-3">
          <div>
            <label className="block text-xs text-secondary mb-1">
              Nickname
            </label>
            <input
              type="text"
              required
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-blue"
            />
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
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span className="text-xs text-foreground">
              Active — the agent trades this account
            </span>
          </label>
          {noteEl(detailsNote)}
          <button
            type="submit"
            disabled={detailsBusy}
            className="rounded-lg bg-blue text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {detailsBusy ? "Saving…" : "Save changes"}
          </button>
        </form>

        {/* Rotate keys */}
        <form
          onSubmit={rotate}
          className="space-y-3 border-t border-border pt-5"
        >
          <h4 className="text-xs font-semibold text-foreground">
            Rotate API keys
          </h4>
          <p className="text-[11px] text-muted">
            Replace the stored Alpaca credentials. New keys are validated before
            they are saved.
          </p>
          <input
            type="text"
            placeholder="New API key"
            autoComplete="off"
            spellCheck={false}
            value={rotKey}
            onChange={(e) => setRotKey(e.target.value)}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm font-mono outline-none focus:border-blue"
          />
          <input
            type="password"
            placeholder="New API secret"
            autoComplete="off"
            spellCheck={false}
            value={rotSecret}
            onChange={(e) => setRotSecret(e.target.value)}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm font-mono outline-none focus:border-blue"
          />
          {noteEl(rotNote)}
          <button
            type="submit"
            disabled={rotBusy || !rotKey || !rotSecret}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-secondary hover:bg-surface disabled:opacity-50"
          >
            {rotBusy ? "Validating…" : "Rotate keys"}
          </button>
        </form>

        {/* Danger zone */}
        <div className="space-y-3 border-t border-border pt-5">
          <h4 className="text-xs font-semibold text-red">Delete account</h4>
          {!confirmingDelete ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded-lg border border-red/30 text-red px-4 py-2 text-sm font-medium hover:bg-red/5"
            >
              Delete this account
            </button>
          ) : (
            <div className="rounded-lg bg-red/5 border border-red/20 p-3 space-y-3">
              <p className="text-xs text-foreground">
                The Alpaca credentials will be permanently removed from Vault.
                This cannot be undone.
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={purgeHistory}
                  onChange={(e) => setPurgeHistory(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-xs text-foreground">
                  Also delete this account&apos;s history (snapshots, trades).
                  Leave unchecked to keep the history.
                </span>
              </label>
              {noteEl(deleteNote)}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleteBusy}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-secondary hover:bg-surface disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={remove}
                  disabled={deleteBusy}
                  className="rounded-lg bg-red text-white px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                >
                  {deleteBusy ? "Deleting…" : "Permanently delete"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
