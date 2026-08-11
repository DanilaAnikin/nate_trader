import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPortfolioHistory, refreshBrokerDatasets } from "./broker-refresh";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * One refresh, one reservation, one publish — and nothing written unless both
 * datasets validated completely.
 *
 * The reservation is taken *before* the broker is read and carries the
 * identity the read is happening against, so a rotation landing mid-fetch is
 * refused rather than mixed in. Every failure below asserts `mirrorMutated:
 * false` and that no publish call was made at all.
 */

const ACCOUNT_ID = "acc-1";
const OWNER_ID = "99999999-9999-9999-9999-999999999999";

let rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let tokens: string[] = [];
let publishError: { message: string } | null = null;
let credentials: { api_key: string; api_secret: string }[] | null = null;

function service(): SupabaseClient<Database> {
  let nextGeneration = 0;
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "begin_broker_refresh_with_credentials") {
        // One transaction returns both, so the double must too: a stub that
        // served credentials separately could not exercise the property.
        if (credentials === null || credentials.length === 0) {
          return {
            data: null,
            error: { message: "account has no stored credentials" },
          };
        }
        nextGeneration += 1;
        const token = `tok-${nextGeneration}`;
        tokens.push(token);
        return {
          data: {
            token,
            generation: nextGeneration,
            credential_version: 1,
            mode: "paper",
            account_number: "PA-1",
            api_key: credentials[0].api_key,
            api_secret: credentials[0].api_secret,
          },
          error: null,
        };
      }
      if (name === "publish_broker_refresh") {
        if (publishError) return { data: null, error: publishError };
        return {
          data: {
            generation: 1,
            equity_written: (args.p_equity as unknown[]).length,
            equity_removed: 0,
            flows_written: (args.p_flows as unknown[]).length,
            flows_removed: 0,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient<Database>;
}

/** A well-formed portfolio history and one cash activity. */
function stubBroker(
  options: {
    history?: unknown;
    activityPages?: unknown[][];
    historyRejects?: unknown;
    activitiesReject?: unknown;
    historyBody?: string;
  } = {},
) {
  const history = options.history ?? {
    timestamp: [1_754_000_000, 1_754_086_400],
    equity: [1000, 1010],
    profit_loss: [0, 10],
    profit_loss_pct: [0, 0.01],
  };
  const activityPages = options.activityPages ?? [
    [
      {
        id: "act-1",
        activity_type: "CSD",
        date: "2026-08-04",
        net_amount: "100",
      },
    ],
    [],
  ];
  let page = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/account/portfolio/history")) {
        if (options.historyRejects) throw options.historyRejects;
        if (options.historyBody !== undefined) {
          return new Response(options.historyBody, { status: 200 });
        }
        return new Response(JSON.stringify(history), { status: 200 });
      }
      if (url.includes("/account/activities")) {
        if (options.activitiesReject) throw options.activitiesReject;
        const body = activityPages[Math.min(page, activityPages.length - 1)];
        page += 1;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
}

function publishCalls() {
  return rpcCalls.filter((call) => call.name === "publish_broker_refresh");
}

beforeEach(() => {
  rpcCalls = [];
  tokens = [];
  publishError = null;
  credentials = [{ api_key: "k", api_secret: "s" }];
  vi.unstubAllGlobals();
});

describe("refreshBrokerDatasets publishes once, or not at all", () => {
  it("reserves, fetches both datasets, then publishes them under that token", async () => {
    stubBroker();
    const result = await refreshBrokerDatasets(
      service(),
      ACCOUNT_ID,
      OWNER_ID,
      "paper",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The reservation is the *first* database call. Reading credentials
    // before it left a window in which a rotation produced a token naming a
    // version the fetched key did not belong to.
    const order = rpcCalls.map((call) => call.name);
    expect(order[0]).toBe("begin_broker_refresh_with_credentials");
    expect(order).not.toContain("get_account_credentials");
    expect(order.indexOf("begin_broker_refresh_with_credentials")).toBeLessThan(
      order.indexOf("publish_broker_refresh"),
    );

    expect(publishCalls()).toHaveLength(1);
    const published = publishCalls()[0].args;
    expect(published.p_token).toBe(tokens[0]);
    expect(published.p_equity_complete).toBe(true);
    expect(published.p_flows_complete).toBe(true);
    // The walk ended on an explicit empty page, and says so.
    expect(published.p_flows_saw_empty_page).toBe(true);
    expect((published.p_equity as unknown[]).length).toBe(2);
    expect((published.p_flows as unknown[]).length).toBe(1);
    expect(published.p_flows_scanned).toBe(1);
  });

  it("never publishes a token it did not reserve", async () => {
    stubBroker();
    await refreshBrokerDatasets(service(), ACCOUNT_ID, OWNER_ID, "paper");
    expect(publishCalls()[0].args.p_token).toBe(tokens[0]);
  });

  it.each([
    [
      "a null equity value",
      { history: { timestamp: [1_754_000_000], equity: [null] } },
      "PORTFOLIO_HISTORY_UNREADABLE",
    ],
    [
      "an empty portfolio history",
      { history: { timestamp: [], equity: [] } },
      "PORTFOLIO_HISTORY_UNREADABLE",
    ],
    [
      "two rows for the same ET session",
      {
        history: {
          // 13:30Z and 20:00Z on the same New York day.
          timestamp: [1_754_314_200, 1_754_337_600],
          equity: [1000, 1010],
        },
      },
      "PORTFOLIO_HISTORY_UNREADABLE",
    ],
    [
      "a repeated timestamp",
      {
        history: {
          timestamp: [1_754_000_000, 1_754_000_000],
          equity: [1000, 1010],
        },
      },
      "PORTFOLIO_HISTORY_UNREADABLE",
    ],
    [
      "an unusable profit_loss entry",
      {
        history: {
          timestamp: [1_754_000_000, 1_754_086_400],
          equity: [1000, 1010],
          profit_loss: [0, "n/a"],
        },
      },
      "PORTFOLIO_HISTORY_UNREADABLE",
    ],
    [
      "a short optional column",
      {
        history: {
          timestamp: [1_754_000_000, 1_754_086_400],
          equity: [1000, 1010],
          profit_loss: [0],
        },
      },
      "PORTFOLIO_HISTORY_UNREADABLE",
    ],
    [
      "a malformed activity",
      {
        activityPages: [
          [{ id: "x", activity_type: "CSD", net_amount: "nope" }],
          [],
        ],
      },
      "CASH_FLOW_INCOMPLETE",
    ],
    [
      "an activity type this build does not classify",
      {
        activityPages: [
          [
            {
              id: "x",
              activity_type: "NEWTRANSFER",
              date: "2026-08-04",
              net_amount: "1",
            },
          ],
          [],
        ],
      },
      "CASH_FLOW_INCOMPLETE",
    ],
    [
      "a securities transfer",
      {
        activityPages: [
          [
            {
              id: "x",
              activity_type: "ACATS",
              date: "2026-08-04",
              net_amount: "0",
            },
          ],
          [],
        ],
      },
      "NON_CASH_EXTERNAL_TRANSFER",
    ],
  ])("writes nothing when there is %s", async (_label, options, reason) => {
    stubBroker(options);
    const result = await refreshBrokerDatasets(
      service(),
      ACCOUNT_ID,
      OWNER_ID,
      "paper",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(reason);
    expect(result.mirrorMutated).toBe(false);
    // The decisive assertion: the publish never happened, so no mirror moved.
    expect(publishCalls()).toHaveLength(0);
  });

  it("writes nothing when the account has no credentials", async () => {
    credentials = [];
    stubBroker();
    const result = await refreshBrokerDatasets(
      service(),
      ACCOUNT_ID,
      OWNER_ID,
      "paper",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("NO_CREDENTIALS");
    expect(result.reservationTaken).toBe(false);
    expect(rpcCalls.map((call) => call.name)).not.toContain(
      "publish_broker_refresh",
    );
  });
});

describe("a broker that does not answer", () => {
  it.each([
    ["a timeout", new DOMException("timed out", "TimeoutError")],
    ["an abort", new DOMException("aborted", "AbortError")],
    [
      "a DNS failure",
      Object.assign(new TypeError("fetch failed"), {
        cause: new Error("getaddrinfo ENOTFOUND paper-api.alpaca.markets"),
      }),
    ],
    [
      "a TLS failure",
      Object.assign(new TypeError("fetch failed"), {
        cause: new Error("unable to verify the first certificate"),
      }),
    ],
  ])(
    "turns %s on the history endpoint into a named failure, not a throw",
    async (_label, thrown) => {
      stubBroker({ historyRejects: thrown });
      const result = await refreshBrokerDatasets(
        service(),
        ACCOUNT_ID,
        OWNER_ID,
        "paper",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("BROKER_UNREACHABLE");
      expect(result.mirrorMutated).toBe(false);
      expect(publishCalls()).toHaveLength(0);
    },
  );

  it("turns a rejected activities fetch into a named failure", async () => {
    stubBroker({
      activitiesReject: new DOMException("timed out", "TimeoutError"),
    });
    const result = await refreshBrokerDatasets(
      service(),
      ACCOUNT_ID,
      OWNER_ID,
      "paper",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("BROKER_UNREACHABLE");
    expect(publishCalls()).toHaveLength(0);
  });

  it("turns malformed JSON into a named failure", async () => {
    stubBroker({ historyBody: "{not json" });
    const result = await refreshBrokerDatasets(
      service(),
      ACCOUNT_ID,
      OWNER_ID,
      "paper",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("PORTFOLIO_HISTORY_UNREADABLE");
    expect(result.detail).toContain("not valid JSON");
  });
});

describe("the database's refusals are reported, not retried", () => {
  it.each([
    [
      "RECONCILIATION_CONFLICT: the portfolio history no longer reports stored session(s) 2026-04-01.",
      "RECONCILIATION_CONFLICT",
    ],
    [
      "credentials changed during the refresh (version 1 -> 2); nothing was written",
      "CREDENTIALS_ROTATED",
    ],
    [
      "the broker account number changed during the refresh; nothing was written",
      "CREDENTIALS_ROTATED",
    ],
    [
      "refresh generation 4 is not newer than the published generation 7",
      "STALE_GENERATION",
    ],
    ["refresh token tok-1 has already been published", "STALE_GENERATION"],
  ])("maps %s", async (message, reason) => {
    stubBroker();
    publishError = { message };
    const result = await refreshBrokerDatasets(
      service(),
      ACCOUNT_ID,
      OWNER_ID,
      "paper",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(reason);
    expect(result.mirrorMutated).toBe(false);
    // A reservation *was* taken — that is a database write, and saying "no
    // mutation" without qualification would be false.
    expect(result.reservationTaken).toBe(true);
    expect(result.detail).toContain("the stored mirror is unchanged");
  });
});

describe("fetchPortfolioHistory rejects the whole payload", () => {
  const ok = (body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );

  it("accepts a clean column-oriented payload", async () => {
    ok({
      timestamp: [1_754_000_000, 1_754_086_400],
      equity: [1000, 1010],
      profit_loss: [null, 10],
      profit_loss_pct: [null, 0.01],
    });
    const result = await fetchPortfolioHistory("k", "s", "paper");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.days).toHaveLength(2);
    expect(result.days[0].profit_loss).toBeNull();
    expect(result.days[1].profit_loss).toBe(10);
  });

  it("does not resolve a duplicate session last-wins", async () => {
    ok({
      timestamp: [1_754_314_200, 1_754_337_600],
      equity: [1000, 9999],
    });
    const result = await fetchPortfolioHistory("k", "s", "paper");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("more than once");
  });
});
