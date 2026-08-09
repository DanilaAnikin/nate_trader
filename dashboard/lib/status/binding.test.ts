import { describe, expect, it } from "vitest";
import type { ProductionAuthorization } from "./authz";
import { maskAccountNumber, resolveAccountBinding } from "./binding";

const AUTHORIZED: ProductionAuthorization = {
  authorized: true,
  reason: null,
  detail: "Signed-in production owner and configured production account match.",
};

const DENIED: ProductionAuthorization = {
  authorized: false,
  reason: "NOT_PRODUCTION_OWNER",
  detail: "The signed-in user is not the configured production owner.",
};

describe("maskAccountNumber", () => {
  it("reveals at most the last four characters", () => {
    expect(maskAccountNumber("PA3ABCDE1234")).toBe("••••1234");
    expect(maskAccountNumber("12")).toBeNull();
    expect(maskAccountNumber(null)).toBeNull();
    expect(maskAccountNumber(undefined)).toBeNull();
  });

  it("never returns any part of the number beyond the last four", () => {
    const masked = maskAccountNumber("PA3ABCDE1234");
    expect(masked).not.toContain("PA3");
    expect(masked).not.toContain("ABCDE");
  });
});

describe("resolveAccountBinding", () => {
  it("reports a production role only when authorization succeeded", () => {
    const binding = resolveAccountBinding({
      accountId: "acc-1",
      nickname: "Paper prod",
      mode: "paper",
      liveBrokerAccountNumber: "PA3ABCDE1234",
      authorization: AUTHORIZED,
    });
    expect(binding.role).toBe("PRODUCTION_CONTROLLED_PAPER");
    expect(binding.productionBound).toBe(true);
    expect(binding.bindingProof).toBe(
      "server-authorized-production-owner-and-account",
    );
    expect(binding.brokerAccountMask).toBe("••••1234");
  });

  it("reports observer-only when authorization was denied", () => {
    const binding = resolveAccountBinding({
      accountId: "acc-9",
      nickname: "Second paper",
      mode: "paper",
      liveBrokerAccountNumber: "PA9ZZZZ0000",
      authorization: DENIED,
    });
    expect(binding.role).toBe("OBSERVER_ONLY_PAPER");
    expect(binding.productionBound).toBe(false);
    expect(binding.bindingProof).toBeNull();
    expect(binding.bindingDetail).toContain("NOT_APPLICABLE");
  });

  it("never binds a live account, even when authorization somehow succeeded", () => {
    const binding = resolveAccountBinding({
      accountId: "acc-1",
      nickname: "Real money",
      mode: "live",
      liveBrokerAccountNumber: "PA3ABCDE1234",
      authorization: AUTHORIZED,
    });
    expect(binding.role).toBe("READ_ONLY_LIVE");
    expect(binding.productionBound).toBe(false);
    expect(binding.bindingDetail).toContain("never trades a live account");
  });

  it("only ever exposes a mask, never the number", () => {
    const binding = resolveAccountBinding({
      accountId: "acc-1",
      nickname: "Paper prod",
      mode: "paper",
      liveBrokerAccountNumber: "PA3ABCDE1234",
      authorization: AUTHORIZED,
    });
    expect(JSON.stringify(binding)).not.toContain("PA3ABCDE1234");
  });
});
