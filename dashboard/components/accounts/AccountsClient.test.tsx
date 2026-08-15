/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AccountsClient from "./AccountsClient";
import type { SafeAccount } from "@/lib/accounts/read";
import type { AccountBindingInfo } from "@/lib/status/types";

vi.mock("@/lib/account-actions", () => ({ selectAccount: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const FULL_ACCOUNT_NUMBER = "PA-LEAK-CANARY-4242";

const PRODUCTION: SafeAccount = {
  id: "acc-prod",
  nickname: "Paper production",
  mode: "paper",
  status: "connected",
  color: "#007aff",
  is_active: true,
  brokerAccountMask: "••••4242",
  last_verified_at: "2026-08-07T16:00:00Z",
  created_at: "2026-05-01T00:00:00Z",
};

const OBSERVER: SafeAccount = {
  ...PRODUCTION,
  id: "acc-observer",
  nickname: "Second paper",
  brokerAccountMask: "••••9999",
};

const LIVE: SafeAccount = {
  ...PRODUCTION,
  id: "acc-live",
  nickname: "Real money",
  mode: "live",
  brokerAccountMask: "••••1111",
};

const BINDINGS: Record<string, AccountBindingInfo> = {
  "acc-prod": {
    selectedAccountId: "acc-prod",
    selectedAccountNickname: "Paper production",
    mode: "paper",
    role: "PRODUCTION_CONTROLLED_PAPER",
    productionBound: true,
    bindingProof: "server-authorized-production-owner-and-account",
    bindingDetail: "Signed-in production owner and configured account match.",
    brokerAccountMask: "••••4242",
  },
  "acc-observer": {
    selectedAccountId: "acc-observer",
    selectedAccountNickname: "Second paper",
    mode: "paper",
    role: "OBSERVER_ONLY_PAPER",
    productionBound: false,
    bindingProof: null,
    bindingDetail: "Not the configured production executor account.",
    brokerAccountMask: "••••9999",
  },
  "acc-live": {
    selectedAccountId: "acc-live",
    selectedAccountNickname: "Real money",
    mode: "live",
    role: "READ_ONLY_LIVE",
    productionBound: false,
    bindingProof: null,
    bindingDetail: "Read-only monitoring; never traded by V11.",
    brokerAccountMask: "••••1111",
  },
};

function renderAccounts() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      const match = url.match(/\/api\/accounts\/([^/]+)\/live/);
      if (match) {
        return new Response(
          JSON.stringify({
            accountId: match[1],
            broker: { equity: 1_000_000, positionCount: 3 },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    }),
  );
  return render(
    <AccountsClient
      initialAccounts={[PRODUCTION, OBSERVER, LIVE]}
      selectedAccountId="acc-prod"
      bindings={BINDINGS}
    />,
  );
}

describe("AccountsClient", () => {
  it("labels each account with its server-resolved role", async () => {
    renderAccounts();
    await waitFor(() =>
      expect(
        screen.getByText("PRODUCTION-CONTROLLED PAPER ACCOUNT"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("OBSERVER-ONLY PAPER ACCOUNT")).toBeInTheDocument();
    expect(screen.getByText("READ-ONLY LIVE ACCOUNT")).toBeInTheDocument();
  });

  it("renders only masked broker account numbers", async () => {
    renderAccounts();
    await waitFor(() =>
      expect(screen.getByText(/••••4242/)).toBeInTheDocument(),
    );
    const html = document.body.innerHTML;
    expect(html).not.toContain(FULL_ACCOUNT_NUMBER);
    expect(html).not.toContain("PA-LEAK-CANARY");
  });

  it("never marks more than the proven account as production-controlled", async () => {
    renderAccounts();
    await waitFor(() =>
      expect(
        screen.getByText("PRODUCTION-CONTROLLED PAPER ACCOUNT"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getAllByText("PRODUCTION-CONTROLLED PAPER ACCOUNT"),
    ).toHaveLength(1);
  });

  it("states that switching the observer account changes nothing in production", async () => {
    renderAccounts();
    await waitFor(() =>
      expect(
        screen.getByText(/never changes which account the guarded/i),
      ).toBeInTheDocument(),
    );
  });
});
