# Candidate acceptance

These checks complement the unit suite and the unauthenticated Playwright
build tests. They do not deploy, migrate, place orders or change GitHub settings.

## Real Vault lifecycle on a disposable clone

From `dashboard/`, run `node test/acceptance/run-clone.mjs CLONE_CONTAINER`.
The container must have `nate.acceptance.clone=true` or
`nate.audit=pg17-upgrade`, no published ports, and only `none` or Docker internal
networks. Production `natetrader-*` names are rejected before Docker access.
The clone needs the complete schema through 0023 and the real Supabase Vault.

The SQL creates a synthetic Auth owner and exercises current service-role
create/idempotency/metadata/rotation/verification/refresh/history/delete RPCs.
It uses dummy keys and never contacts Alpaca. Credentials stay inside SQL
variables. All fixture rows roll back; sequences can advance on the clone.
Output is only a fixed PASS/FAIL record. Database errors are deliberately not
forwarded because the clone may contain private production data.

## Read probes against the staged or public application

Run `node test/acceptance/read-probe.mjs` with one JSON object on stdin:

- `origin`: HTTPS application origin, or a loopback HTTP tunnel.
- `cookie`: optional existing authenticated Cookie header, held only in memory.
- `forbiddenValues`: optional private string canaries that must not occur in responses.
- `requireAccounts`: require at least one account for the authenticated owner.
- `requireBrokerReady`: require current broker data in each tested status response.
- `expectedAccountId`: require this account in the owned list and always test its APIs.

Feed sensitive configuration from a private process or protected tmpfs; do not
put session cookies in command arguments, shell history, permanent files or
logs. The probe never prints headers, identifiers, response bodies or canaries.
It follows no redirects and sends only GET requests. The application's normal
Auth session refresh can still occur while handling an authenticated request.

Anonymous probes require working health/login, login redirects for protected
pages and 401 for protected APIs. Authenticated probes require profile/account
reads, all main pages, and the first three owned accounts' status/live/equity/
performance endpoints. Status responses must carry every expected section and
the selected account's mode. An explicit unavailable research/runtime section
is valid; missing sections, backend errors and leaked credential fields fail.

A caller selecting a specific account should also include its `nt_account`
cookie so the rendered pages and account API probes select the same account.

A dedicated Auth probe user without accounts verifies authentication and the
empty-account application. It does not establish that the owner's broker data
or production binding works; that requires a separately authorized owner read.
