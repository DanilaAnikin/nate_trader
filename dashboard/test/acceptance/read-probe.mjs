/**
 * GET-only acceptance. JSON config comes from stdin, including an optional
 * existing Cookie header and secret canaries. Nothing sensitive is printed.
 * No login, refresh POST, account writes, artifacts, or trading calls here.
 */
import { pathToFileURL } from "node:url";

const PAGES = ["/", "/positions", "/screener", "/research", "/operations", "/accounts", "/settings"];
const SECTIONS = ["web", "release", "authorization", "accountBinding", "broker", "strategy", "universe", "validation", "preflight", "execution", "operations", "tournament", "convergence"];
const PRIVATE_KEYS = new Set(["api_key", "api_secret", "apiKey", "apiSecret", "alpaca_key_secret_id", "alpaca_secret_secret_id", "decrypted_secret", "account_number", "alpaca_account_number"]);

function containsPrivateFields(body) {
  const queue = [body];
  while (queue.length) {
    const item = queue.pop();
    if (!item || typeof item !== "object") continue;
    for (const [key, value] of Object.entries(item)) {
      if (PRIVATE_KEYS.has(key)) return true;
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return false;
}

export async function runReadProbes(config, request = fetch, emit = (row) => process.stdout.write(JSON.stringify(row) + "\n")) {
  let failed = false;
  const record = (check, passed, status) => {
    if (!passed) failed = true;
    emit({ check, result: passed ? "PASS" : "FAIL", ...(status === undefined ? {} : { status }) });
  };
  const origin = new URL(config.origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && local)) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("An HTTPS origin or loopback HTTP origin is required");
  }
  if (config.cookie !== undefined && (typeof config.cookie !== "string" || /[\r\n]/.test(config.cookie))) {
    throw new Error("Invalid cookie input");
  }
  if (config.expectedAccountId !== undefined && (typeof config.expectedAccountId !== "string" || !config.expectedAccountId)) {
    throw new Error("Invalid expected account input");
  }
  const canaries = config.forbiddenValues ?? [];
  if (!Array.isArray(canaries) || canaries.some((value) => typeof value !== "string" || value.length < 6)) {
    throw new Error("Invalid private canaries");
  }
  const read = async (path, authenticated = false) => {
    const response = await request(new URL(path, origin), {
      method: "GET", redirect: "manual", cache: "no-store",
      headers: authenticated ? { Cookie: config.cookie } : {},
      signal: AbortSignal.timeout(45000),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    const privateValue = canaries.some((value) => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1)));
    return { response, body, text, safe: !privateValue && !containsPrivateFields(body) };
  };
  const health = await read("/api/health");
  record("public_health", health.response.status === 200 && health.safe, health.response.status);
  const login = await read("/login");
  record("public_login", login.response.status === 200 && login.safe, login.response.status);
  for (const path of PAGES) {
    const result = await read(path);
    const location = result.response.headers.get("location");
    const loginRedirect = [302, 303, 307, 308].includes(result.response.status) && location && new URL(location, origin).pathname === "/login";
    record(`anonymous_page_${path === "/" ? "overview" : path.slice(1)}`, !!loginRedirect && result.safe, result.response.status);
  }
  const anonymousApis = ["/api/accounts", "/api/profile", "/api/accounts/00000000-0000-0000-0000-000000000000/status"];
  for (let i = 0; i < anonymousApis.length; i++) {
    const result = await read(anonymousApis[i]);
    record(`anonymous_api_${i + 1}`, result.response.status === 401 && result.safe, result.response.status);
  }
  if (!config.cookie) return !failed;

  for (const path of PAGES) {
    const result = await read(path, true);
    record(`authenticated_page_${path === "/" ? "overview" : path.slice(1)}`, result.response.status === 200 && result.safe, result.response.status);
  }
  const profile = await read("/api/profile", true);
  record("authenticated_profile", profile.response.status === 200 && profile.safe && !!profile.body?.profile, profile.response.status);
  const accounts = await read("/api/accounts", true);
  const list = accounts.body?.accounts;
  const validList = accounts.response.status === 200 && accounts.safe && Array.isArray(list)
    && list.every((account) => typeof account.id === "string" && ["paper", "live"].includes(account.mode));
  record("authenticated_accounts", validList, accounts.response.status);
  if (!validList) return false;
  if (config.requireAccounts) record("owned_account_present", list.length > 0);
  const expectedAccount = config.expectedAccountId
    ? list.find((account) => account.id === config.expectedAccountId) : null;
  if (config.expectedAccountId) {
    record("configured_account_present", !!expectedAccount);
    if (!expectedAccount) return false;
  }
  // Always exercise the configured account, even when it is not among the
  // owner's first three rows. The caller can also pin its nt_account cookie
  // so the server-rendered pages select the same account.
  const testedAccounts = expectedAccount
    ? [expectedAccount, ...list.filter((account) => account.id !== expectedAccount.id)].slice(0, 3)
    : list.slice(0, 3);
  for (const [index, account] of testedAccounts.entries()) {
    for (const endpoint of ["status", "live", "equity", "performance"]) {
      const result = await read(`/api/accounts/${encodeURIComponent(account.id)}/${endpoint}`, true);
      let valid = result.response.status === 200 && result.safe && result.body?.accountId === account.id;
      if (endpoint === "status") {
        valid = valid && result.body?.accountMode === account.mode && SECTIONS.every((key) => result.body[key] && typeof result.body[key] === "object");
        if (config.requireBrokerReady) valid = valid && result.body?.broker?.provenance?.freshness === "CURRENT" && !!result.body?.broker?.data;
      }
      record(`owned_account_${index + 1}_${endpoint}`, !!valid, result.response.status);
    }
  }
  return !failed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 65536) throw new Error("Configuration too large");
    }
    process.exitCode = await runReadProbes(JSON.parse(input)) ? 0 : 1;
  } catch {
    process.stdout.write(JSON.stringify({ check: "probe_configuration_or_transport", result: "FAIL" }) + "\n");
    process.exitCode = 1;
  }
}
