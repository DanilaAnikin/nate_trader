// ===========================================================================
// keys.mjs — the canary stack's throwaway JWTs.
//
// NONE OF THIS IS A CREDENTIAL. There is no Supabase project behind the canary
// stack: `SUPABASE_SERVER_URL` points at `sink.mjs`, which is the harness's own
// recording gateway and is also the only thing that ever validates these
// tokens. The signing secret below is a literal string that says so, checked
// into the repository on purpose, so that:
//
//   * the image built for the frozen run and the image built for the mutant run
//     carry the same build-time `NEXT_PUBLIC_*` values and are therefore
//     comparable, and
//   * a run is reproducible on another host without provisioning anything.
//
// A real Supabase key must never be given to this harness. The sink refuses to
// forward a token it did not mint, so one would not work anyway.
// ===========================================================================

import { createHmac, randomUUID } from "node:crypto";

export const JWT_SECRET = "nt-runtime-canary-not-a-secret-signing-key";

/** The disposable identity, created by sql/15_probe_identity.sql in OUR clone. */
export const PROBE_USER_ID = "33333333-3333-4333-8333-333333333333";
export const PROBE_USER_EMAIL = "runtime-canary-probe@example.invalid";

/** The seeded fixture account, from the reused schema-compat seed. */
export const FIXTURE_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
export const FIXTURE_USER_ID = "11111111-1111-4111-8111-111111111111";

/** The account the probe user owns, so an authenticated mutation has a target. */
export const PROBE_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function sign(payload) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64url(mac)}`;
}

// Far-future expiry so a slow matrix run cannot turn a token refresh into a
// spurious "Auth call".
const IAT = 1767225600; // 2026-01-01T00:00:00Z
const EXP = 2145916800; // 2038-01-01T00:00:00Z

export const ANON_KEY = sign({ iss: "nt-runtime-canary", role: "anon", iat: IAT, exp: EXP });
export const SERVICE_ROLE_KEY = sign({
  iss: "nt-runtime-canary",
  role: "service_role",
  iat: IAT,
  exp: EXP,
});
export const PROBE_ACCESS_TOKEN = sign({
  iss: "nt-runtime-canary",
  sub: PROBE_USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: PROBE_USER_EMAIL,
  session_id: "00000000-0000-4000-8000-0000000000ff",
  iat: IAT,
  exp: EXP,
});

/**
 * The cookie @supabase/ssr writes for a session.
 *
 * ssr >= 0.5 stores `base64-` + base64 of the session JSON, chunking across
 * `<name>.0`, `<name>.1`, ... when it exceeds the cookie size limit. The
 * session below is small enough to fit in one cookie; the harness asserts that
 * the server actually treated the request as authenticated rather than
 * assuming this encoding is right (see driver/drive.mjs `authProof`).
 */
export function sessionCookieValue() {
  const session = {
    access_token: PROBE_ACCESS_TOKEN,
    token_type: "bearer",
    expires_in: 1_000_000_000,
    expires_at: EXP,
    refresh_token: "nt-canary-refresh-not-a-credential",
    user: {
      id: PROBE_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: PROBE_USER_EMAIL,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { display_name: "Runtime Canary Probe" },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  };
  return "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64");
}

export const COOKIE_NAME = "sb-canary-auth-token";

/** A fresh id for a run, used only to label artefacts. */
export const runId = () => randomUUID().slice(0, 8);

if (process.argv[2] === "--print-shell") {
  const out = [
    `CANARY_ANON_KEY=${ANON_KEY}`,
    `CANARY_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}`,
    `CANARY_PROBE_ACCESS_TOKEN=${PROBE_ACCESS_TOKEN}`,
    `CANARY_COOKIE_NAME=${COOKIE_NAME}`,
    `CANARY_PROBE_USER_ID=${PROBE_USER_ID}`,
    `CANARY_PROBE_ACCOUNT_ID=${PROBE_ACCOUNT_ID}`,
    `CANARY_FIXTURE_ACCOUNT_ID=${FIXTURE_ACCOUNT_ID}`,
  ];
  process.stdout.write(out.join("\n") + "\n");
}
