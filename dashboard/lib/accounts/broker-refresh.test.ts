import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshBrokerDatasets } from "./broker-refresh";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * One refresh, one generation, one publish.
 *
 * The two mirrors used to be written independently as each was fetched, so a
 * failure part-way left one updated and the other not, and two overlapping
 * refreshes could publish in either order. These assert the two properties
 * that replaced that: **nothing is written unless both datasets validated**,
 * and a refresh that started earlier cannot land on top of a newer one.
 */

const ACCOUNT_ID = "acc-1";
const OWNER_ID = "99999999-9999-9999-9999-999999999999";

let rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let generations: number[] = [];
let publishError: { message: string } | null = null;
let credentials: { api_key: string; api_secret: string }[] | null = null;

function service(): SupabaseClient<Database> {
  let nextGeneration = 0;
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "get_account_credentials") {
        return { data: credentials, error: null };
      }
      if (name === "begin_broker_refresh") {
        nextGeneration += 1;
        generations.push(nextGeneration);
        return { data: nextGeneration, error: null };
      }
      if (name === "publish_broker_refresh") {
        if (publishError) return { data: null, error: publishError };
        return {
          data: {
            generation: args.p_generation,
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
  options: { history?: unknown; activities?: unknown[] } = {},
) {
  const history = options.history ?? {
    timestamp: [1_754_000_000, 1_754_086_400],
    equity: [1000, 1010],
    profit_loss: [0, 10],
    profit_loss_pct: [0, 0.01],
  };
  const activities = options.activities ?? [
    {
      id: "act-1",
      activity_type: "CSD",
      date: "2026-08-04",
      net_amount: "100",
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/account/portfolio/history")) {
        return new Response(JSON.stringify(history), { status: 200 });
      }
      if (url.includes("/account/activities")) {
        const token = new URL(url).searchParams.get("page_token");
        return new Response(JSON.stringify(token ? [] : activities), {
          status: 200,
        });
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
  generations = [];
  publishError = null;
  credentials = [{ api_key: "k", api_secret: "s" }];
  vi.unstubAllGlobals();
});

describe("refreshBrokerDatasets publishes once, or not at all", () => {
  it("takes a generation, fetches both datasets, then publishes them together", async () => {
    stubBroker();
    const result = await refreshBrokerDatasets(
      service(),
      ACCOUNT_ID,
      OWNER_ID,
      "paper",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The generation is reserved *before* the broker is read, so a refresh
    // that started earlier can be recognised as older even if it lands later.
    const order = rpcCalls.map((call) => call.name);
    expect(order[0]).toBe("get_account_credentials");
    expect(order).toContain("begin_broker_refresh");
    expect(order.indexOf("begin_broker_refresh")).toBeLessThan(
      order.indexOf("publish_broker_refresh"),
    );

    expect(publishCalls()).toHaveLength(1);
    const published = publishCalls()[0].args;
    expect(published).toMatchObject({
      p_account: ACCOUNT_ID,
      p_owner: OWNER_ID,
      p_equity_complete: true,
      p_flows_complete: true,
    });
    expect((published.p_equity as unknown[]).length).toBe(2);
    expect((published.p_flows as unknown[]).length).toBe(1);
    expect(published.p_flows_scanned).toBe(1);
  });

  it.each([
    [
      "an unusable portfolio history",
      { history: { timestamp: [1_754_000_000], equity: [null] } },
      "PORTFOLIO_HISTORY_UNREADABLE",
    ],
    [
      "an empty portfolio history",
      { history: { timestamp: [], equity: [] } },
      "PORTFOLIO_HISTORY_UNREADABLE",
    ],
    [
      "a malformed activity",
      { activities: [{ id: "x", activity_type: "CSD", net_amount: "nope" }] },
      "CASH_FLOW_INCOMPLETE",
    ],
    [
      "an unrequested activity type",
      {
        activities: [
          { id: "x", activity_type: "FILL", date: "2026-08-04", net_amount: "1" },
        ],
      },
      "CASH_FLOW_INCOMPLETE",
    ],
    [
      "a securities transfer",
      {
        activities: [
          { id: "x", activity_type: "ACATS", date: "2026-08-04", net_amount: "0" },
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
    expect(result.mutated).toBe(false);
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
    expect(rpcCalls.map((call) => call.name)).not.toContain(
      "begin_broker_refresh",
    );
  });

  it("reports a rejected stale generation rather than retrying it", async () => {
    stubBroker();
    publishError = {
      message: "refresh generation 4 is not newer than the published generation 7",
    };
    const result = await refreshBrokerDatasets(
      service(),
      ACCOUNT_ID,
      OWNER_ID,
      "paper",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("STALE_GENERATION");
    expect(result.mutated).toBe(false);
  });

  it("bounds the activity window at the supplied baseline", async () => {
    stubBroker();
    await refreshBrokerDatasets(service(), ACCOUNT_ID, OWNER_ID, "paper", {
      flowsFrom: "2026-08-03T13:30:00.000Z",
    });
    expect(publishCalls()[0].args.p_flows_from).toBe("2026-08-03");
  });
});

describe("two refresh generations completing in the wrong order", () => {
  it("gives the later starter the higher generation", async () => {
    // The database refuses the lower one; this asserts the halves the
    // application is responsible for — that generations are taken in order and
    // carried through to the publish unchanged.
    stubBroker();
    const svc = service();

    const first = await refreshBrokerDatasets(svc, ACCOUNT_ID, OWNER_ID, "paper");
    const second = await refreshBrokerDatasets(svc, ACCOUNT_ID, OWNER_ID, "paper");

    expect(first.ok && second.ok).toBe(true);
    expect(generations).toEqual([1, 2]);
    const published = publishCalls().map((call) => call.args.p_generation);
    expect(published).toEqual([1, 2]);
  });

  it("never publishes a generation it did not reserve", async () => {
    stubBroker();
    await refreshBrokerDatasets(service(), ACCOUNT_ID, OWNER_ID, "paper");
    const reserved = generations[0];
    expect(publishCalls()[0].args.p_generation).toBe(reserved);
  });
});
