import { describe, expect, it } from "vitest";
import { toSafe } from "./service";
import type { Database } from "@/lib/database.types";

/**
 * The client-facing account DTO is an allowlist.
 *
 * A unique fixture value is used for the full broker account number so a leak
 * anywhere in the serialized output is unambiguous.
 */
export const FULL_ACCOUNT_NUMBER = "PA-LEAK-CANARY-4242";
const VAULT_KEY_ID = "11111111-2222-3333-4444-555555555555";
const VAULT_SECRET_ID = "66666666-7777-8888-9999-000000000000";
const OWNER_ID = "99999999-9999-9999-9999-999999999999";

const ROW: Database["public"]["Tables"]["accounts"]["Row"] = {
  id: "acc-1",
  owner_id: OWNER_ID,
  nickname: "Paper production",
  mode: "paper",
  status: "connected",
  color: "#007aff",
  alpaca_key_secret_id: VAULT_KEY_ID,
  alpaca_secret_secret_id: VAULT_SECRET_ID,
  alpaca_account_number: FULL_ACCOUNT_NUMBER,
  is_active: true,
  last_verified_at: "2026-08-07T16:00:00Z",
  last_synced_at: "2026-08-07T16:00:00Z",
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-08-07T16:00:00Z",
  deleted_at: null,
};

describe("toSafe", () => {
  it("exposes only the allowlisted fields", () => {
    expect(Object.keys(toSafe(ROW)).sort()).toEqual([
      "brokerAccountMask",
      "color",
      "created_at",
      "id",
      "is_active",
      "last_verified_at",
      "mode",
      "nickname",
      "status",
    ]);
  });

  it("replaces the broker account number with a four-character mask", () => {
    const safe = toSafe(ROW);
    expect(safe.brokerAccountMask).toBe("••••4242");
    expect(JSON.stringify(safe)).not.toContain(FULL_ACCOUNT_NUMBER);
    expect(JSON.stringify(safe)).not.toContain("PA-LEAK-CANARY");
  });

  it("never carries Vault identifiers, owner_id or deleted_at", () => {
    const serialized = JSON.stringify(toSafe(ROW));
    expect(serialized).not.toContain(VAULT_KEY_ID);
    expect(serialized).not.toContain(VAULT_SECRET_ID);
    expect(serialized).not.toContain(OWNER_ID);
    expect(serialized).not.toContain("owner_id");
    expect(serialized).not.toContain("deleted_at");
    expect(serialized).not.toContain("alpaca");
  });

  it("keeps the mask null when there is no verified number", () => {
    expect(toSafe({ ...ROW, alpaca_account_number: null }).brokerAccountMask).toBe(
      null,
    );
  });

  it("is not an Omit of the row — a new sensitive column stays out by default", () => {
    const rowWithFutureColumn = {
      ...ROW,
      some_future_secret: "should-never-be-serialized",
    } as unknown as Database["public"]["Tables"]["accounts"]["Row"];
    expect(JSON.stringify(toSafe(rowWithFutureColumn))).not.toContain(
      "should-never-be-serialized",
    );
  });
});
