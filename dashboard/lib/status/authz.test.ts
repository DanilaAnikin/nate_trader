import { describe, expect, it } from "vitest";
import {
  authorizeProductionRuntime,
  readProductionAuthzConfig,
  type ProductionAuthzConfig,
} from "./authz";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";
const PROD_ACCOUNT = "aaaaaaaa-0000-0000-0000-00000000000a";
const OTHER_ACCOUNT = "bbbbbbbb-0000-0000-0000-00000000000b";

const BROKER_NUMBER = "PA3ABCDE1234";

const FULL_CONFIG: ProductionAuthzConfig = {
  productionOwnerUserId: OWNER,
  productionAccountId: PROD_ACCOUNT,
  productionBrokerAccountNumber: BROKER_NUMBER,
  productionAccountMode: "paper",
};

function authorize(overrides: Partial<Parameters<typeof authorizeProductionRuntime>[0]> = {}) {
  return authorizeProductionRuntime({
    viewerUserId: OWNER,
    accountId: PROD_ACCOUNT,
    accountOwnerId: OWNER,
    mode: "paper",
    liveBrokerAccountNumber: BROKER_NUMBER,
    config: FULL_CONFIG,
    ...overrides,
  });
}

describe("readProductionAuthzConfig", () => {
  it("reads all inputs and treats blanks as absent", () => {
    expect(
      readProductionAuthzConfig({
        PRODUCTION_OWNER_USER_ID: ` ${OWNER} `,
        PRODUCTION_ACCOUNT_ID: PROD_ACCOUNT,
        PRODUCTION_ALPACA_ACCOUNT_NUMBER: "  ",
      }),
    ).toEqual({
      productionOwnerUserId: OWNER,
      productionAccountId: PROD_ACCOUNT,
      productionBrokerAccountNumber: null,
      productionAccountMode: "paper",
    });
  });

  it("defaults the production mode to paper when it is unset", () => {
    expect(readProductionAuthzConfig({}).productionAccountMode).toBe("paper");
  });

  it("reads live only from the exact word, case-insensitively", () => {
    expect(
      readProductionAuthzConfig({ PRODUCTION_ACCOUNT_MODE: "live" })
        .productionAccountMode,
    ).toBe("live");
    expect(
      readProductionAuthzConfig({ PRODUCTION_ACCOUNT_MODE: " LIVE " })
        .productionAccountMode,
    ).toBe("live");
  });

  it("falls back to paper for anything that is not exactly live", () => {
    // A typo must land on the mode that cannot spend real money.
    for (const value of ["", "  ", "yes", "true", "1", "livee", "live!", "real"]) {
      expect(
        readProductionAuthzConfig({ PRODUCTION_ACCOUNT_MODE: value })
          .productionAccountMode,
      ).toBe("paper");
    }
  });
});

describe("authorizeProductionRuntime", () => {
  it("authorizes only the configured owner viewing the configured paper account", () => {
    const result = authorize();
    expect(result.authorized).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.detail).toContain("freshly verified");
  });

  it("refuses when no production broker account number is configured", () => {
    // Owner + account + paper mode say who is asking about which row; they
    // cannot show that the row's credentials point at the executor's broker
    // account, so the broker-side identifier is mandatory.
    expect(
      authorize({
        config: { ...FULL_CONFIG, productionBrokerAccountNumber: null },
      }).reason,
    ).toBe("BROKER_BINDING_NOT_CONFIGURED");
  });

  it("refuses when nothing is configured", () => {
    expect(
      authorize({
        config: {
          productionOwnerUserId: null,
          productionAccountId: null,
          productionBrokerAccountNumber: null,
          productionAccountMode: "paper",
        },
      }).reason,
    ).toBe("NOT_CONFIGURED");
  });

  it("refuses a half-configured deployment", () => {
    expect(
      authorize({
        config: { ...FULL_CONFIG, productionAccountId: null },
      }).reason,
    ).toBe("NOT_CONFIGURED");
    expect(
      authorize({
        config: { ...FULL_CONFIG, productionOwnerUserId: null },
      }).reason,
    ).toBe("NOT_CONFIGURED");
  });

  it("refuses a different signed-in user, even on the production account", () => {
    const result = authorize({
      viewerUserId: OTHER_USER,
      accountOwnerId: OTHER_USER,
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("NOT_PRODUCTION_OWNER");
  });

  it("refuses the production owner on one of their other accounts", () => {
    expect(authorize({ accountId: OTHER_ACCOUNT }).reason).toBe(
      "NOT_PRODUCTION_ACCOUNT",
    );
  });

  it("refuses a live account when the server declares a paper executor", () => {
    // This used to be an outright ban, because the executor was paper-only.
    // Live is now supported, so the rule became a *match*: the account's mode
    // has to equal the mode the server declares out of band.
    expect(authorize({ mode: "live" }).reason).toBe("ACCOUNT_MODE_MISMATCH");
  });

  it("refuses a paper account when the server declares a live executor", () => {
    // The mismatch is refused in both directions. Showing a paper account
    // under a live executor's runtime would tell the reader that real money is
    // moving when it is not — a quieter error, and a worse one, than the
    // reverse.
    expect(
      authorize({
        mode: "paper",
        config: { ...FULL_CONFIG, productionAccountMode: "live" },
      }).reason,
    ).toBe("ACCOUNT_MODE_MISMATCH");
  });

  it("authorizes a live account only when live is explicitly declared", () => {
    const result = authorize({
      mode: "live",
      config: { ...FULL_CONFIG, productionAccountMode: "live" },
    });
    expect(result.authorized).toBe(true);
    expect(result.detail).toContain("live mode");
  });

  it("still requires every other condition for a live production account", () => {
    // Declaring live must not become a way around the rest of the AND-gate.
    const liveConfig = { ...FULL_CONFIG, productionAccountMode: "live" as const };
    expect(
      authorize({ mode: "live", config: liveConfig, viewerUserId: OTHER_USER })
        .reason,
    ).toBe("NOT_PRODUCTION_OWNER");
    expect(
      authorize({ mode: "live", config: liveConfig, accountId: OTHER_ACCOUNT })
        .reason,
    ).toBe("NOT_PRODUCTION_ACCOUNT");
    expect(
      authorize({
        mode: "live",
        config: liveConfig,
        liveBrokerAccountNumber: "PA9ZZZZZ9999",
      }).reason,
    ).toBe("BROKER_ACCOUNT_MISMATCH");
    expect(
      authorize({
        mode: "live",
        config: liveConfig,
        liveBrokerAccountNumber: null,
      }).reason,
    ).toBe("BROKER_ACCOUNT_UNVERIFIED");
  });

  it("refuses when the configured account is not owned by the owner", () => {
    expect(authorize({ accountOwnerId: OTHER_USER }).reason).toBe(
      "ACCOUNT_NOT_OWNED_BY_PRODUCTION_OWNER",
    );
    expect(authorize({ accountOwnerId: null }).reason).toBe(
      "ACCOUNT_NOT_OWNED_BY_PRODUCTION_OWNER",
    );
  });

  describe("mandatory broker account-number AND check", () => {
    it("tolerates surrounding whitespace on a genuine match", () => {
      expect(
        authorize({ liveBrokerAccountNumber: ` ${BROKER_NUMBER} ` }).authorized,
      ).toBe(true);
    });

    it("refuses when the freshly read number differs", () => {
      expect(
        authorize({ liveBrokerAccountNumber: "PA9ZZZZ0000" }).reason,
      ).toBe("BROKER_ACCOUNT_MISMATCH");
    });

    it("refuses when the live account could not be read at all", () => {
      expect(authorize({ liveBrokerAccountNumber: null }).reason).toBe(
        "BROKER_ACCOUNT_UNVERIFIED",
      );
    });

    it("is an AND check, never an alternative proof of identity", () => {
      // A matching broker number cannot rescue a wrong user or wrong account.
      expect(
        authorize({
          viewerUserId: OTHER_USER,
          accountOwnerId: OTHER_USER,
        }).authorized,
      ).toBe(false);
      expect(authorize({ accountId: OTHER_ACCOUNT }).authorized).toBe(false);
    });
  });
});
