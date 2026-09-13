import { test } from "node:test";
import assert from "node:assert/strict";
import { runOwnerAcceptance } from "./owner_read_acceptance.mjs";

const OWNER = "11111111-1111-1111-1111-111111111111";
const ACCOUNT = "22222222-2222-2222-2222-222222222222";
const SHA = "a".repeat(40);
const env = {
  SUPABASE_SERVER_URL: "http://natetrader-supabase-kong:8000",
  SUPABASE_SERVICE_ROLE_KEY: "private-service-value", NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon",
  PRODUCTION_OWNER_USER_ID: OWNER, PRODUCTION_ACCOUNT_ID: ACCOUNT,
  NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME: "sb-ntapi-auth-token", NATE_EXPECTED_BUILD_SHA: SHA,
};

function fixture({ owner = OWNER, factors = [], probeThrows = false, logoutFails = false } = {}) {
  const calls = [], output = [], probeConfigs = [];
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, query: new URL(url).search, options });
    let body;
    if (path === "/api/health") body = { buildSha: SHA };
    else if (path === "/rest/v1/accounts") body = [{ owner_id: owner, deleted_at: null }];
    else if (path.startsWith("/auth/v1/admin/users/")) body = { id: OWNER, email: "owner@example.invalid", email_confirmed_at: "2026-01-01", factors };
    else if (path === "/auth/v1/admin/generate_link") body = { id: OWNER, verification_type: "magiclink", hashed_token: "private-otp" };
    else if (path === "/auth/v1/verify") body = { access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, user: { id: OWNER } };
    else if (path === "/auth/v1/logout") return new Response(null, { status: logoutFails ? 500 : 204 });
    else throw new Error("Unexpected network destination");
    return Response.json(body);
  };
  return {
    calls, output, probeConfigs,
    options: { env, fetcher, emit: row => output.push(row), loadProbe: async () => async config => {
      probeConfigs.push(config);
      if (probeThrows) throw new Error("private failure body");
      return true;
    } },
  };
}

test("uses a real SSR cookie and revokes only its own session without printing credentials", async () => {
  const x = fixture();
  assert.equal(await runOwnerAcceptance(x.options), true);
  const config = x.probeConfigs[0];
  assert.ok(config.cookie.startsWith("sb-ntapi-auth-token=base64-"));
  const value = config.cookie.split("=base64-")[1].split(";")[0];
  assert.equal(JSON.parse(Buffer.from(value, "base64url")).access_token, "private-access");
  assert.equal(config.requireAccounts, true);
  assert.equal(config.requireBrokerReady, true);
  assert.equal(config.expectedAccountId, ACCOUNT);
  assert.ok(config.cookie.includes(`nt_account=${ACCOUNT}`));
  const logout = x.calls.find(call => call.path === "/auth/v1/logout");
  assert.equal(logout.query, "?scope=local");
  const printable = JSON.stringify(x.output);
  for (const privateValue of ["private-access", "private-refresh", "private-service", OWNER, "owner@example.invalid"]) {
    assert.ok(!printable.includes(privateValue));
  }
  assert.deepEqual(x.calls.filter(call => call.options.method === "POST").map(call => call.path),
    ["/auth/v1/admin/generate_link", "/auth/v1/verify", "/auth/v1/logout"]);
  const adminCall = x.calls.find(call => call.path === "/auth/v1/admin/generate_link");
  assert.equal(adminCall.options.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(x.calls.find(call => call.path === "/auth/v1/verify").options.headers.apikey,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
});

test("does not mint an owner session when binding differs or MFA is configured", async () => {
  for (const change of [{ owner: ACCOUNT }, { factors: [{ status: "verified" }] }]) {
    const x = fixture(change);
    assert.equal(await runOwnerAcceptance(x.options), false);
    assert.ok(!x.calls.some(call => call.path === "/auth/v1/admin/generate_link"));
  }
});

test("revokes the acceptance session even if an application probe crashes", async () => {
  const x = fixture({ probeThrows: true });
  assert.equal(await runOwnerAcceptance(x.options), false);
  assert.ok(x.calls.some(call => call.path === "/auth/v1/logout" && call.query === "?scope=local"));
  assert.ok(!JSON.stringify(x.output).includes("private failure body"));
});

test("a failed logout makes acceptance fail", async () => {
  const x = fixture({ logoutFails: true });
  assert.equal(await runOwnerAcceptance(x.options), false);
  assert.deepEqual(x.output.at(-1), { check: "acceptance_session_revoked", result: "FAIL" });
});

test("cannot send secrets to another origin or start without an exact build", async () => {
  for (const patch of [{ NATE_ACCEPTANCE_ORIGIN: "https://example.invalid" }, { NATE_EXPECTED_BUILD_SHA: "main" }]) {
    const x = fixture();
    assert.equal(await runOwnerAcceptance({ ...x.options, env: { ...env, ...patch } }), false);
    assert.equal(x.calls.length, 0);
  }
});
