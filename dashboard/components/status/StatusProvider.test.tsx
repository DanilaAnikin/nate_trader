/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import StatusProvider, { useStrategyStatus } from "./StatusProvider";
import { buildPayload } from "@/test/payload-builder";

const ACCOUNT_A = { id: "acc-1", nickname: "Paper prod", mode: "paper" as const };
const ACCOUNT_B = { id: "acc-2", nickname: "Second paper", mode: "paper" as const };

function Probe() {
  const { status, data, error } = useStrategyStatus();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="account">{data?.accountNickname ?? "none"}</span>
      <span data-testid="equity">{data?.broker.data?.equity ?? "none"}</span>
      <span data-testid="error">{error?.code ?? "none"}</span>
    </div>
  );
}

function stubStatusFetch(
  responder: (accountId: string) => { status?: number; body: unknown },
) {
  const fn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const match = url.match(/\/api\/accounts\/([^/]+)\/status/);
    if (!match) return new Response("{}", { status: 404 });
    const { status = 200, body } = responder(decodeURIComponent(match[1]));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("StatusProvider", () => {
  it("publishes a validated payload for the selected account", async () => {
    stubStatusFetch(() => ({ body: buildPayload() }));
    render(
      <StatusProvider enabled selectedAccount={ACCOUNT_A}>
        <Probe />
      </StatusProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("ready"),
    );
    expect(screen.getByTestId("account")).toHaveTextContent("Paper prod");
    expect(screen.getByTestId("equity")).toHaveTextContent("881532.2");
  });

  it("refuses a payload whose account identity does not match the request", async () => {
    // The server answers with account A's payload for an account-B request.
    stubStatusFetch(() => ({ body: buildPayload() }));
    render(
      <StatusProvider enabled selectedAccount={ACCOUNT_B}>
        <Probe />
      </StatusProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("error"),
    );
    expect(screen.getByTestId("error")).toHaveTextContent("INVALID_RESPONSE");
    expect(screen.getByTestId("account")).toHaveTextContent("none");
  });

  it("does not bleed account A's data through after switching to account B", async () => {
    stubStatusFetch((accountId) =>
      accountId === "acc-1"
        ? { body: buildPayload() }
        : {
            body: buildPayload({
              accountId: "acc-2",
              accountNickname: "Second paper",
            }),
          },
    );

    const view = render(
      <StatusProvider enabled selectedAccount={ACCOUNT_A}>
        <Probe />
      </StatusProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("account")).toHaveTextContent("Paper prod"),
    );

    view.rerender(
      <StatusProvider enabled selectedAccount={ACCOUNT_B}>
        <Probe />
      </StatusProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("account")).toHaveTextContent("Second paper"),
    );
    expect(screen.getByTestId("account")).not.toHaveTextContent("Paper prod");
  });

  it("surfaces an authentication failure instead of rendering stale data", async () => {
    stubStatusFetch(() => ({
      status: 401,
      body: { code: "UNAUTHENTICATED", error: "Authentication is required." },
    }));
    render(
      <StatusProvider enabled selectedAccount={ACCOUNT_A}>
        <Probe />
      </StatusProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("UNAUTHENTICATED"),
    );
    expect(screen.getByTestId("account")).toHaveTextContent("none");
  });

  it("reports no-account and disabled states without fetching", async () => {
    const fn = stubStatusFetch(() => ({ body: buildPayload() }));
    render(
      <StatusProvider enabled selectedAccount={null}>
        <Probe />
      </StatusProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("no-account"),
    );
    expect(fn).not.toHaveBeenCalled();
  });
});
