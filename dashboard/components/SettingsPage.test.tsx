/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SettingsPage from "@/app/(app)/settings/page";

const browser = vi.hoisted(() => ({
  auth: { getUser: vi.fn(async () => ({ data: { user: { id: "owner", email: "owner@example.test" } } })) },
  from: vi.fn(() => { throw new Error("Public data routes are denied"); }),
}));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseBrowser: () => browser }));

describe("Settings behind an Auth-only public gateway", () => {
  it("loads and saves preferences through same-origin API while public Supabase handles Auth", async () => {
    const request = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input) === "/api/profile") {
        return Response.json({ profile: { display_name: init?.method ? "Updated" : "Owner", default_account_id: null } });
      }
      if (String(input) === "/api/accounts") return Response.json({ accounts: [] });
      throw new Error("Unexpected data origin");
    });
    vi.stubGlobal("fetch", request);
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByDisplayValue("Owner")).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue("Owner"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(screen.getByText("Profile saved.")).toBeInTheDocument());
    expect(request).toHaveBeenCalledWith("/api/profile", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ display_name: "Updated" }),
    }));
    expect(browser.from).not.toHaveBeenCalled();
    expect(screen.getByText(/new monthly targets are capped at 75% of account equity/)).toBeInTheDocument();
    expect(screen.queryByText("SPY must close above its 200-session SMA")).not.toBeInTheDocument();
  });

  it("reports unavailable preferences without presenting a blank editable profile", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })));
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Settings could not be loaded"));
    expect(screen.queryByRole("button", { name: "Save profile" })).not.toBeInTheDocument();
  });
});
