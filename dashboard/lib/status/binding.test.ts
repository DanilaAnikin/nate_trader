import { describe, expect, it } from "vitest";
import {
  maskAccountNumber,
  readBindingConfig,
  resolveAccountBinding,
} from "./binding";

const NO_CONFIG = {
  productionAccountId: null,
  productionBrokerAccountNumber: null,
};

describe("readBindingConfig", () => {
  it("reads both binding inputs and treats blanks as absent", () => {
    expect(
      readBindingConfig({
        PRODUCTION_ACCOUNT_ID: "acc-1",
        PRODUCTION_ALPACA_ACCOUNT_NUMBER: "  PA123456  ",
      }),
    ).toEqual({
      productionAccountId: "acc-1",
      productionBrokerAccountNumber: "PA123456",
    });
    expect(
      readBindingConfig({ PRODUCTION_ACCOUNT_ID: "   " }),
    ).toEqual(NO_CONFIG);
  });
});

describe("maskAccountNumber", () => {
  it("reveals at most the last four characters", () => {
    expect(maskAccountNumber("PA3ABCDE1234")).toBe("••••1234");
    expect(maskAccountNumber("12")).toBeNull();
    expect(maskAccountNumber(null)).toBeNull();
  });
});

describe("resolveAccountBinding", () => {
  it("binds a paper account by the configured account id", () => {
    const binding = resolveAccountBinding({
      accountId: "acc-1",
      nickname: "Paper prod",
      mode: "paper",
      brokerAccountNumber: "PA3ABCDE1234",
      config: { productionAccountId: "acc-1", productionBrokerAccountNumber: null },
    });
    expect(binding.role).toBe("PRODUCTION_CONTROLLED_PAPER");
    expect(binding.productionBound).toBe(true);
    expect(binding.bindingProof).toBe("server-configured-account-id");
    expect(binding.brokerAccountMask).toBe("••••1234");
  });

  it("binds a paper account by the configured broker account number", () => {
    const binding = resolveAccountBinding({
      accountId: "acc-2",
      nickname: "Paper prod",
      mode: "paper",
      brokerAccountNumber: "PA3ABCDE1234",
      config: {
        productionAccountId: null,
        productionBrokerAccountNumber: "PA3ABCDE1234",
      },
    });
    expect(binding.productionBound).toBe(true);
    expect(binding.bindingProof).toBe(
      "server-configured-broker-account-number",
    );
  });

  it("marks a different paper account observer-only", () => {
    const binding = resolveAccountBinding({
      accountId: "acc-9",
      nickname: "Second paper",
      mode: "paper",
      brokerAccountNumber: "PA9ZZZZ0000",
      config: {
        productionAccountId: "acc-1",
        productionBrokerAccountNumber: "PA3ABCDE1234",
      },
    });
    expect(binding.role).toBe("OBSERVER_ONLY_PAPER");
    expect(binding.productionBound).toBe(false);
    expect(binding.bindingProof).toBeNull();
    expect(binding.bindingDetail).toContain("NOT_APPLICABLE");
  });

  it("never binds a live account, even if it matches the configuration", () => {
    const binding = resolveAccountBinding({
      accountId: "acc-1",
      nickname: "Real money",
      mode: "live",
      brokerAccountNumber: "PA3ABCDE1234",
      config: {
        productionAccountId: "acc-1",
        productionBrokerAccountNumber: "PA3ABCDE1234",
      },
    });
    expect(binding.role).toBe("READ_ONLY_LIVE");
    expect(binding.productionBound).toBe(false);
    expect(binding.bindingDetail).toContain("never trades a live account");
  });

  it("refuses to guess when nothing is configured", () => {
    const binding = resolveAccountBinding({
      accountId: "acc-1",
      nickname: "Only paper account",
      mode: "paper",
      brokerAccountNumber: "PA3ABCDE1234",
      config: NO_CONFIG,
    });
    expect(binding.role).toBe("OBSERVER_ONLY_PAPER");
    expect(binding.bindingDetail).toContain("No server-side production-account");
  });

  it("does not bind on a null broker account number", () => {
    const binding = resolveAccountBinding({
      accountId: "acc-2",
      nickname: "Unverified",
      mode: "paper",
      brokerAccountNumber: null,
      config: {
        productionAccountId: null,
        productionBrokerAccountNumber: "PA3ABCDE1234",
      },
    });
    expect(binding.productionBound).toBe(false);
  });
});
