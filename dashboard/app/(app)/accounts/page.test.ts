import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSelectedAccount: vi.fn(),
  accountsClient: vi.fn(() => "account-list"),
}));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServer: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/account-context", () => ({ getSelectedAccount: mocks.getSelectedAccount }));
vi.mock("@/components/accounts/AccountsClient", () => ({ default: mocks.accountsClient }));

import AccountsPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "owner" } } });
  mocks.getSelectedAccount.mockResolvedValue({ accounts: [], selected: null });
});

describe("accounts page availability", () => {
  it("renders a recoverable unavailable state when account selection fails", async () => {
    mocks.getSelectedAccount.mockRejectedValueOnce(new Error("private database diagnostics"));
    const html = renderToStaticMarkup(await AccountsPage());
    expect(html).toContain('role="alert"');
    expect(html).toContain("Accounts could not be loaded");
    expect(html).not.toContain("private database diagnostics");
    expect(mocks.accountsClient).not.toHaveBeenCalled();
  });

  it("renders the same unavailable state if its independent auth read fails", async () => {
    mocks.getUser.mockRejectedValueOnce(new Error("connection failed"));
    const html = renderToStaticMarkup(await AccountsPage());
    expect(html).toContain("Accounts could not be loaded");
    expect(mocks.getSelectedAccount).not.toHaveBeenCalled();
    expect(mocks.accountsClient).not.toHaveBeenCalled();
  });

  it("still renders the account manager for a successfully loaded empty list", async () => {
    const html = renderToStaticMarkup(await AccountsPage());
    expect(html).toBe("account-list");
    expect(mocks.accountsClient).toHaveBeenCalledWith(expect.objectContaining({
      initialAccounts: [], selectedAccountId: null,
    }), undefined);
  });
});
