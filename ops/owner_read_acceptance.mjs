/**
 * Run inside the staged dashboard after database acceptance, using its existing
 * configured production owner. Admin generate_link does not send email. A new
 * short-lived Auth session is used for GET-only application probes and revoked
 * with scope=local; passwords and the owner's other sessions are untouched.
 * Tokens, email, identifiers and response bodies never leave process memory.
 * Supply NATE_EXPECTED_BUILD_SHA; copy the repository read-probe.mjs to /tmp.
 */
import { pathToFileURL } from "node:url";

export async function runOwnerAcceptance({
  env = process.env,
  fetcher = fetch,
  loadProbe = async () => (await import("file:///tmp/nate-read-probe.mjs")).runReadProbes,
  emit = (row) => process.stdout.write(JSON.stringify(row) + "\n"),
} = {}) {
const report = (check, ok) => emit({
  check, result: ok ? "PASS" : "FAIL",
});
let accessToken;
let failed = false;
const base = env.SUPABASE_SERVER_URL;
const service = env.SUPABASE_SERVICE_ROLE_KEY;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const owner = env.PRODUCTION_OWNER_USER_ID;
const account = env.PRODUCTION_ACCOUNT_ID;
const origin = env.NATE_ACCEPTANCE_ORIGIN || "http://127.0.0.1:3000";

async function request(path, bearer, body) {
  const response = await fetcher(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { apikey: bearer === service ? service : anon,
      Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Acceptance request refused");
  return response.status === 204 ? null : response.json();
}

try {
  if (base !== "http://natetrader-supabase-kong:8000" || !service || !anon ||
      !/^[0-9a-f-]{36}$/.test(owner || "") || !/^[0-9a-f-]{36}$/.test(account || "") ||
      !/^[0-9a-f]{40}$/.test(env.NATE_EXPECTED_BUILD_SHA || "")) {
    throw new Error("Explicit production deployment binding required");
  }
  if (!["http://127.0.0.1:3000", "https://nate-trader.anikin.cz"].includes(origin)) {
    throw new Error("Unexpected acceptance origin");
  }
  const health = await fetcher(origin + "/api/health", { signal: AbortSignal.timeout(10000) });
  if (!health.ok || (await health.json()).buildSha !== env.NATE_EXPECTED_BUILD_SHA) {
    throw new Error("Wrong deployment build");
  }
  const rows = await request(`/rest/v1/accounts?id=eq.${account}&select=owner_id,deleted_at`, service);
  if (rows.length !== 1 || rows[0].owner_id !== owner || rows[0].deleted_at !== null) {
    throw new Error("Production account owner not verified");
  }
  const user = await request(`/auth/v1/admin/users/${owner}`, service);
  if (user.id !== owner || !user.email || !user.email_confirmed_at) {
    throw new Error("Existing confirmed owner required");
  }
  // Do not bypass an owner's interactive second factor during deployment.
  if (user.factors?.some((factor) => factor.status === "verified")) {
    throw new Error("Interactive MFA required for owner acceptance");
  }
  const link = await request("/auth/v1/admin/generate_link", service, {
    type: "magiclink", email: user.email,
  });
  if (link.id !== owner || link.verification_type !== "magiclink" || !link.hashed_token) {
    throw new Error("Unexpected generated verification link");
  }
  const session = await request("/auth/v1/verify", anon, {
    type: "magiclink", token_hash: link.hashed_token,
  });
  accessToken = session.access_token;
  if (!accessToken || !session.refresh_token || session.user?.id !== owner) {
    throw new Error("Unexpected acceptance session");
  }
  session.expires_at ??= Math.floor(Date.now() / 1000) + session.expires_in;
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  const name = env.NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Explicit cookie name required");
  const chunks = value.match(/.{1,3000}/g);
  const authCookie = chunks.length === 1 ? `${name}=${value}`
    : chunks.map((part, index) => `${name}.${index}=${part}`).join("; ");
  const cookie = `${authCookie}; nt_account=${account}`;
  report("owner_acceptance_session", true);
  const runReadProbes = await loadProbe();
  failed = !await runReadProbes({
    origin, cookie, expectedAccountId: account, requireAccounts: true, requireBrokerReady: true,
    forbiddenValues: [service, env.GITHUB_TOKEN, env.PRODUCTION_ALPACA_ACCOUNT_NUMBER,
      accessToken, session.refresh_token].filter((value) => value?.length >= 6),
  }, fetcher, emit);
} catch {
  report("owner_acceptance_setup_or_transport", false);
  failed = true;
} finally {
  if (accessToken) {
    try {
      await request("/auth/v1/logout?scope=local", accessToken, {});
      report("acceptance_session_revoked", true);
    } catch {
      report("acceptance_session_revoked", false);
      failed = true;
    }
  }
}
return !failed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runOwnerAcceptance() ? 0 : 1;
}
