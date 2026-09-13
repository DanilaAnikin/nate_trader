# Nate dashboard deployment runbook

Production deployment completed on **2026-09-13 at 11:26:05 UTC** with dashboard
source `d8288a31f884793197b6fa9f3ea8ac2b92b55a99`, image
`sha256:f28f5131cc3aee28f5b9d1ff7e6da4ea184fb0ccadda52c1c99c4044a12a4811`
and writes enabled. The database upgrade committed at 11:21:35 UTC. Public owner
acceptance and containment monitoring each passed 29 checks; all seven checks
also passed for the exact merged source. [Deployment evidence](deployments/2026-09-13.json)
records the release inputs and acceptance hashes.

The operational HTTP helpers have one verified post-build correction: they send
explicit `NateTrader-Deployment/1.0` / `NateTrader-Monitor/1.0` user agents. The
edge returned 403 to the default Python user agent while these identified clients
and curl received the expected responses. All 28 deployment/monitor tests pass.
The operator source hashes are recorded separately from the unchanged dashboard
image. The installed helper sources live under
`/var/lib/homelab/nate-trader/operator-releases/c51b348bce3b0b3b3230c783d774b8ed64979526fa1745cdf88cdad1f583a144/`.

The following sequence documents this deployment and future application
cutovers. The bounded legacy database upgrade is **not rerunnable** after the
Nate ledger exists; future schema upgrades need a new reviewed migration plan.

## Release inputs and boundaries

- Complete [the database procedure](../docs/DATABASE_UPGRADE.md) first. The
  current bridge expects a legacy database; the candidate needs the contract
  through 0023. Never replay 0001–0008.
- Keep the Auth-only gateway at `ntapi.anikin.cz`; public REST, GraphQL,
  Storage, Realtime, Functions and catchall routes stay denied even after
  dashboard writes are enabled.
- Preserve the existing internal Supabase origin and explicit auth-cookie
  identity. Required secret/config values are carried in memory by
  `deploy_dashboard.py`; do not export Docker environments into files or logs.
- The dashboard source SHA and approved trading SHA are separate inputs.
  Preserve approved paper SHA `115f11fd74591bb270e9529885ea19edf6eab923` until
  its runtime handoff is separately proved. The current September plan has
  10 targets and 15 broker-linked attempts; missing month-convergence evidence
  makes a bare SHA promotion unsafe. Do not reset the forward epoch, replace
  monthly state with repository seeds, or enable live trading during cutover.
- Use an immutable image ID/digest with its `org.opencontainers.image.revision`
  label equal to the selected full source SHA. Pass all release checks for that
  source. This tool does not build images, approve trading or migrate databases.

## Stage, inspect and switch

Run deployment commands as root on `homelab`, from the reviewed release's
operator directory containing `ops/` and `dashboard/`. Copy only nonsecret
helper sources there. Set these two nonsecret inputs from the reviewed release:

```bash
: "${NATE_RELEASE_SHA:?Select the reviewed full dashboard source SHA}"
: "${NATE_IMAGE_ID:?Select the reviewed immutable Docker image ID}"
NATE_APPROVED_TRADING_SHA=115f11fd74591bb270e9529885ea19edf6eab923
NATE_FROZEN_CONTAINER="natetrader-dashboard-${NATE_RELEASE_SHA:0:12}-frozen"
NATE_ACTIVE_CONTAINER="natetrader-dashboard-${NATE_RELEASE_SHA:0:12}-active"
```

1. Apply the exact reviewed production database bundle, confirm its ledger and
   inspect the final schema. A missing client response is not a rollback:
   inspect the ledger before retrying. Retain the old bridge and its route.
2. Stage a frozen candidate. Its public/source runtime bindings come from the
   running bridge; no existing container is implicitly replaced:

   ```bash
   sudo python3 ops/deploy_dashboard.py start \
     --name "$NATE_FROZEN_CONTAINER" --source natetrader-dashboard-bridge \
     --image "$NATE_IMAGE_ID" --sha "$NATE_RELEASE_SHA" \
     --approved-trading-sha "$NATE_APPROVED_TRADING_SHA" --freeze on
   ```

3. Run the owner read acceptance below against the staged container's loopback
   origin. Require the actual configured account, current broker data, every
   expected response section and no credential fields/canaries. Explicitly
   unavailable historical research/runtime evidence can remain unavailable.
4. Compute the live route digest immediately before cutover and switch the
   frozen candidate. The tool refuses drift or an ambiguous backend match:

   ```bash
   NATE_ROUTE_SHA256=$(sudo sha256sum /etc/dokploy/traefik/dynamic/natetrader.yml | cut -d' ' -f1)
   sudo python3 ops/deploy_dashboard.py cutover \
     --from-container natetrader-dashboard-bridge --to-container "$NATE_FROZEN_CONTAINER" \
     --sha "$NATE_RELEASE_SHA" --route-sha256 "$NATE_ROUTE_SHA256" --freeze on
   ```

5. Repeat owner reads through the public origin and run the containment monitor
   with `--check-only`. The public health must identify this exact SHA and have
   `writes_enabled=false`; login must work and anonymous protected APIs must
   refuse access. All expected data-plane paths remain denied.
6. After these checks and the already completed clone mutation acceptance,
   stage the same image in the active container using the frozen candidate as
   `--source`, with `--freeze off`. Repeat staged owner reads, then perform the
   same digest-bound `cutover` from frozen to active with `--freeze off`.
   Recheck the public owner and monitor. Health must now report the selected
   SHA and `writes_enabled=true`. Do not test production account creation,
   credential rotation, verification writes or trading as an acceptance shortcut.

`start` verifies the image/source binding, required environment presence,
internal gateway and unauthenticated internal HTTP/freeze contract. `cutover`
changes only the single dashboard backend URL and monitor expectations,
preserving the API gateway rules. It validates public health, auth and denial
paths. It does not establish owner/broker correctness by itself.

## Existing-owner read acceptance

Choose the exact staged or active container. These copied files are source
code, not session data:

```bash
: "${NATE_ACCEPTANCE_CONTAINER:?Select the exact candidate container}"
sudo docker cp ops/owner_read_acceptance.mjs "$NATE_ACCEPTANCE_CONTAINER:/tmp/nate-owner-acceptance.mjs"
sudo docker cp dashboard/test/acceptance/read-probe.mjs "$NATE_ACCEPTANCE_CONTAINER:/tmp/nate-read-probe.mjs"
sudo docker exec -e NATE_EXPECTED_BUILD_SHA="$NATE_RELEASE_SHA" \
  "$NATE_ACCEPTANCE_CONTAINER" node /tmp/nate-owner-acceptance.mjs
```

Repeat after public cutover with the explicit public origin:

```bash
sudo docker exec -e NATE_EXPECTED_BUILD_SHA="$NATE_RELEASE_SHA" \
  -e NATE_ACCEPTANCE_ORIGIN=https://nate-trader.anikin.cz \
  "$NATE_ACCEPTANCE_CONTAINER" node /tmp/nate-owner-acceptance.mjs
```

The helper verifies the configured existing confirmed owner/account, generates
a short-lived Auth session without sending email, exercises GET-only application
reads and revokes only that session. It does not change the password or revoke
other sessions. Tokens, owner identifiers and response bodies remain in memory;
output is fixed PASS/FAIL. A verified MFA factor requires the owner's interactive
session; the helper refuses to bypass it. A dedicated empty-account probe user
is not a substitute for this owner/broker acceptance.

## Monitoring and evidence

Install the reviewed monitor and its colocated helper together:

```bash
sudo install -m 0755 ops/monitor/nt-containment-monitor.sh /srv/homelab/self-healing/nt-containment-monitor.sh
sudo install -m 0755 ops/monitor/auth_probe.py /srv/homelab/self-healing/auth_probe.py
sudo /srv/homelab/self-healing/nt-containment-monitor.sh --check-only
```

The cutover writes `/var/lib/homelab/nt-containment-expect` with the full SHA,
`EXPECT_REST=denied`, actual freeze state and exact dashboard container. The
monitor exercises Auth availability/signup denial, raw path variants, public
health/freeze, an account-free authenticated identity, GitHub evidence access
and container stability. Missing coverage is UNKNOWN and fails the check.
Credential files already live under `/srv/homelab/secrets/`; the Auth probe
requires root ownership and mode 0600. Never print their values.

Use `--check-only` for manual acceptance: it does not update last-run state or
send notifications. The existing `nt-containment-monitor.timer` invokes the
service at the installed `/srv/homelab/self-healing/` path; preserve that timer
and record its next successful normal run. Back up the previous script and
install the helper first, then atomically replace the monitor script. Retain bounded monitor/owner results,
production migration evidence, final catalogue digest and deployment evidence
under `/var/lib/homelab/nate-trader/deployments/`. Encrypt private SQL/catalogue
artifacts before their temporary workspace is removed.

## Application rollback

The cutover keeps previous containers and records `route.before`,
`expect.before`, `route.after`, `release.json` and `verdict.json`. If public
acceptance fails during cutover, it restores the previous route and monitor
expectations, provided no concurrent edit occurred. A
`configuration_restored` verdict explicitly has `public_rollback_verified=false`:
verify propagation, prior public SHA/freeze, Auth and data-plane denial yourself.

After an accepted active cutover, prefer the retained frozen candidate of the
same release as fallback. Use `cutover` with the current route digest, active
container as `--from-container`, frozen container as `--to-container`, and
`--freeze on`; then repeat public read/monitor acceptance. Never thaw the old
legacy bridge as a way to restore removed credential-writing APIs.

**Application rollback does not roll back database migrations.** Keep the honest
0009–0023 ledger. Full database rollback is a separate recovery operation using
the verified encrypted set, preserving later data when required; never replay
old migrations, delete history, or restore the database automatically on a UI
failure. Record the final production outcome only after all selected acceptance
checks pass.
