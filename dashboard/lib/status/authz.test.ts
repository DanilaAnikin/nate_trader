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
  it("reads all three inputs and treats blanks as absent", () => {
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
    });
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

  it("refuses a live account outright", () => {
    expect(authorize({ mode: "live" }).reason).toBe("NOT_PAPER_MODE");
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
