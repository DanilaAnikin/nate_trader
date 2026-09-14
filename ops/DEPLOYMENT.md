# Nate dashboard deployment runbook

The September 13 dashboard cutover completed at **12:40:15 UTC**, source
`46b59b32bc5af833828e00f56fb0dc121236e12d`, image
`sha256:50c7de05963514c3709f30adb5c1c39d75b8f03a7cf90195e30b35f3c6f9f89f`,
container `natetrader-dashboard-46b59b32bc5a-active`, with writes enabled.
Its 29 staged owner checks and 12 configuration checks passed. Final public
owner acceptance passed 30 checks, including the exact build and approved paper
release gate; the 12:41:19 UTC containment monitor passed 29 checks with zero
failures/unknowns and zero active dashboard restarts.

The original application/database deployment completed at **11:26:05 UTC** with dashboard
source `d8288a31f884793197b6fa9f3ea8ac2b92b55a99`, image
`sha256:f28f5131cc3aee28f5b9d1ff7e6da4ea184fb0ccadda52c1c99c4044a12a4811`
and writes enabled. The database upgrade committed at 11:21:35 UTC. Public owner
acceptance and containment monitoring each passed 29 checks; all seven checks
also passed for the exact merged source. [Deployment evidence](deployments/2026-09-13.json)
records the release inputs and acceptance hashes.

The separate paper handoff implementation is merged in
[PR #92](https://github.com/DanilaAnikin/nate_trader/pull/92) at
`4a90512a09bbbb899b1a373bffb0de8ec358719e`; its exact merged-source release gate
passed all seven jobs. GET-only preparation passed and the exact manifest and
digest pin were approved in `paper-production` at **12:15:35 UTC**. Read-only
production preflight passed. An intermediate public cutover at **12:22:46 UTC**
kept image/source d828 and rebound its approved executor, passing 30 owner and
29 containment checks. The final deployed dashboard reads the seven-file
handoff archive and authenticates the preserved source plan identity.
[PR #93](https://github.com/DanilaAnikin/nate_trader/pull/93) passes 1,282
dashboard tests, 916 Python tests, lint, TypeScript and the production build;
both its PR and exact merged-source release gates passed seven jobs and 38
browser checks. The separate approved paper executor remains at `4a90512a…`.
[Paper handoff evidence](deployments/2026-09-13-paper-handoff.json) records these
stages separately. Follow the
[paper handoff procedure](../docs/PAPER_RUNTIME_HANDOFF.md) for the transition;
the application deployment record below retains its original approved paper
SHA and does not claim that a new executor has run.

The operational HTTP helpers have one verified post-build correction: they send
explicit `NateTrader-Deployment/1.0` / `NateTrader-Monitor/1.0` user agents. The
edge returned 403 to the default Python user agent while these identified clients
and curl received the expected responses. All 28 deployment/monitor tests pass.
The current deployment helper also requires explicit handoff-pin selection;
its SHA-256 is `df6186a450f48caff46a7e3123a32eae62b95023614186d19764c1ad28bc880d`.
Operator source hashes are recorded separately from dashboard images in the
deployment evidence; the Auth probe and containment monitor sources are unchanged.

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
  The original application cutover preserved approved paper SHA
  `115f11fd74591bb270e9529885ea19edf6eab923` until its runtime handoff was
  prepared and explicitly approved. The current September plan has
  10 targets and 15 broker-linked attempts; missing month-convergence evidence
  makes a bare SHA promotion unsafe. Do not reset the forward epoch, replace
  monthly state with repository seeds, or enable live trading during cutover.
- Use an immutable image ID/digest with its `org.opencontainers.image.revision`
  label equal to the selected full source SHA. Pass all release checks for that
  source. This tool does not build images, approve trading or migrate databases.
- A paper dashboard reading retained handoff evidence also needs the reviewed
  manifest digest. Pass it explicitly on **every** `start`, including a second
  candidate started from a correctly configured first one. The optional pin is
  never copied from the source container, and it cannot be attached to a live
  account. Omitting it leaves the new container without handoff authorization;
  the reader then refuses a handoff archive. A second transfer requires a reader
  supporting the exact eleven-file archive and the new explicit manifest pin.

## Stage, inspect and switch

Run deployment commands as root on `homelab`, from the reviewed release's
operator directory containing `ops/` and `dashboard/`. Copy only nonsecret
helper sources there. Set these two nonsecret inputs from the reviewed release:

```bash
: "${NATE_RELEASE_SHA:?Select the reviewed full dashboard source SHA}"
: "${NATE_IMAGE_ID:?Select the reviewed immutable Docker image ID}"
: "${NATE_APPROVED_TRADING_SHA:?Select the separately approved full executor SHA}"
NATE_FROZEN_CONTAINER="natetrader-dashboard-${NATE_RELEASE_SHA:0:12}-frozen"
NATE_ACTIVE_CONTAINER="natetrader-dashboard-${NATE_RELEASE_SHA:0:12}-active"
```

1. For the original database upgrade, apply the exact reviewed bundle, confirm
   its ledger and inspect the final schema. Later application-only releases
   verify the existing contract and do not replay that upgrade. A missing client
   response is not a rollback: inspect the ledger before retrying. Retain the
   currently served container and its route.
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

For the separately approved September 13 paper handoff, the reviewed explicit
staging inputs are below. Select `NATE_RELEASE_SHA`, `NATE_IMAGE_ID` and the
candidate name from the final dashboard merge and its successful release gate;
the PR head is not a deployment SHA. The older sequence above records the
original application cutover's paper approval.

```bash
sudo python3 ops/deploy_dashboard.py start \
  --name "$NATE_ACTIVE_CONTAINER" \
  --source natetrader-dashboard-d8288a31f884-paper-4a90512a09bb \
  --image "$NATE_IMAGE_ID" --sha "$NATE_RELEASE_SHA" \
  --approved-trading-sha 4a90512a09bbbb899b1a373bffb0de8ec358719e \
  --paper-handoff-sha256 dd4cde7980814e627871ffdcc5d74aa0700a7d715f442825364a1dba947e20e5 \
  --freeze off
```

This sets only the dashboard's `PAPER_RUNTIME_HANDOFF_SHA256` reader pin. It does
not approve a trading release or supply the workflow's manifest body. Verify the
container's configured digest without printing its environment, then repeat
owner reads, release/preflight checks and containment acceptance before cutover.

## Paper observability release and second handoff

The September 13 receipt and literal commands above are historical evidence.
They are not default inputs for a later promotion. In particular, a helper that
pins the original bridge, first source artifact, or absent handoff variables
must be reviewed and updated before a second transfer. Existing `/tmp` receipts
can also describe superseded containers; compare them with current public health,
the served container and protected environment before using them.

Use this sequence for the release adding explicit cycle results, verified
runtime generations and the missing-session watchdog. It requires no database
migration and does not change the separately approved live executor:

1. Finish source review and the canonical validation after every strategy
   identity input is frozen. Run the full Python and dashboard regression suites,
   lint/type checks, production build and browser acceptance. Require all seven
   V11 Release Gate jobs for both the reviewed PR and its **exact final main
   merge SHA**: dashboard, repository regression, canonical release eligibility,
   schema/RLS, PostgREST, concurrency and Vault integrity. Confirm the browser
   suite ran inside the dashboard job. A green engineering check alone is not a
   trading-promotion gate.
2. From that clean final merge, build the dashboard image with a matching
   revision label and record its immutable image ID and source-archive digest.
   Carry existing public Auth build inputs from the currently served container
   in memory. Do not reuse a build wrapper's stale source-container constant or
   pass service-role/GitHub/broker credentials as build arguments.
3. Recheck the old approved paper release, its external manifest pin and stored
   body digest, and the newest source artifact/run. Complete the
   [second-transfer preparation](../docs/PAPER_RUNTIME_HANDOFF.md#bounded-second-transfer)
   with the existing prior pin as an explicit input. Preserve the original plan,
   attempts and history; require a fresh, successful source with no newer actual
   attempt. Retain private inputs in the reviewed protected workspace and print
   only bounded verification results. The output must target the final merge,
   not its PR head.
4. Stage the new dashboard image with writes frozen, the new approved executor
   SHA and the **new** handoff pin, explicitly supplied together. The old public
   dashboard remains served. Inspect configuration without printing secrets and
   run existing-owner read acceptance. Until a genuine target execution exists,
   unavailable target execution evidence is expected; do not fabricate a target
   `last_run` or a fresh forward-performance baseline.
5. Replace the protected paper manifest and digest, verify readback, then update
   the approved executor SHA last. Use the normal trusted-default-branch
   `operation=preflight` dispatch and record the exact returned run ID. Verify its
   event, workflow/path, attempt, orchestration head and approved checkout, then
   require restore, offline gate, broker preflight and dry-run preview success.
   Execution, runtime upload and operational incident creation must be skipped.
   Preflight approval itself does not execute orders.
6. Repeat staged owner checks and verify the dashboard's release/preflight
   evidence points to the selected target. Complete the frozen/public then
   active/public cutover procedure above, recomputing the route digest at each
   switch. The new reader must be served before the first eleven-file target
   artifact is produced. Pass the pin again when starting the active container
   from the frozen one; `start` intentionally never inherits it.
7. Observe the next real paper cycle or an independently authorized execution.
   Require a current-run verified generation and exact eleven-file archive with
   original evidence preserved. Inspect `cycle_outcome` separately from producer
   health: `pending` is not completion, and a failed or blocked cycle is never
   repaired by selecting an older PASS. Verify the dashboard agrees with that
   evidence and retains an explicit explanation for unavailable forward history.
   Observe watchdog/day-guard behavior without dispatching an extra acceptance
   cycle. Finish public owner checks, containment `--check-only`, then the next
   scheduled monitor result and durable sanitized deployment receipts.

For both new dashboard starts, the reusable interface is:

```bash
: "${NATE_SOURCE_CONTAINER:?Select the currently served or verified frozen source}"
: "${NATE_PAPER_HANDOFF_SHA256:?Select the newly reviewed manifest digest}"
sudo python3 ops/deploy_dashboard.py start \
  --name "$NATE_FROZEN_CONTAINER" --source "$NATE_SOURCE_CONTAINER" \
  --image "$NATE_IMAGE_ID" --sha "$NATE_RELEASE_SHA" \
  --approved-trading-sha "$NATE_APPROVED_TRADING_SHA" \
  --paper-handoff-sha256 "$NATE_PAPER_HANDOFF_SHA256" --freeze on
```

Use a distinct active name and `--freeze off` for the second start. Preserve the
existing production owner/account, internal gateway and Auth cookie identity.
The application image, approved executor SHA and manifest digest are three
separate bindings; changing any one requires explicit verification of all three.
An application rollback can retain these executor bindings but must use a reader
that understands the eleven-file artifact. The old seven-file-only image is not
a compatible rollback after the second transfer. A paper executor rollback is a
separate state-continuity decision, not merely restoring an older SHA variable.

The [paper runbook](../docs/PAPER_RUNTIME_HANDOFF.md#cycle-results-and-coherent-publication)
defines producer health versus cycle progress, legacy evidence without a
generation proof, strict raw-byte/current-run publication, and the watchdog's
bounded automatic paper execution. Keep these distinctions in acceptance and
deployment receipts; a healthy page or process does not prove a filled rebalance.

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
