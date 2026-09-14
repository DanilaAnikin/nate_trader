# Carry an existing paper execution plan into an approved release

This procedure carries one existing frozen paper plan, its original order IDs,
attempt history and performance history into an explicitly approved target
release. It does not recalculate targets, reset the circuit breaker, create a
performance baseline or submit an order during preparation. Live accounts are
outside this contract. Broker reconciliation accepts only
`https://paper-api.alpaca.markets` and uses fresh GETs.

The workflow keeps concurrency group `nate-trader-v11-paper-production` with
`cancel-in-progress: false`. There is no separate handoff workflow or automatic
approval operation. The ordinary `operation=preflight` restores and validates the
handoff; the first real target execution later writes a truthful target
`production/last_run.json`.

## Visibility and approval

The repository is public. Actions artifact download requires GitHub access, but
that is **not** a confidentiality boundary against signed-in readers of this
public repository. Existing paper runtime artifacts contain financial state.
Neither this implementation nor this procedure changes repository visibility.
Do not place broker credentials in runtime files or manifests.
[GitHub artifact access documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
describes who can download these artifacts.

Approval is the exact manifest SHA-256 in the protected `paper-production`
environment variable `PAPER_RUNTIME_HANDOFF_SHA256`. The independently reviewed
manifest body goes into `PAPER_RUNTIME_HANDOFF_MANIFEST`. It contains hashes,
release/run/artifact IDs and an opaque plan ID, not account IDs, credentials,
target weights or order IDs. Treat the local source ZIP, broker responses and
preparation workspace as private: use an owned `0700` tmpfs directory and `0600`
files, disable tracing and core dumps, and never print their contents.

## Preparation after the final merge

1. Finish source review, merge and verify the exact target merge SHA's release
   gate. Use a clean checkout of that **final merge SHA**, Python `3.12.11`, the
   hash-locked dependencies and its matching canonical validation. A manifest
   prepared for a PR head or an earlier merge is not valid for the final target.
2. Inspect the latest source namespace
   `paper-runtime-state-<SOURCE_RELEASE_SHA>` using read-only GitHub Actions APIs.
   Record the exact source run and artifact IDs and the archive's SHA-256. Check
   the newest executed attempt, including failed/cancelled attempts and missing
   uploads; do not select an older PASS. Download that exact archive to private
   tmpfs without logging its bytes or forwarding a GitHub token to its signed
   blob URL. The restore transport repeats this provenance and freshness check
   before installation.
3. Supply already authorized paper broker credentials through the existing
   protected process environment. Do not put them into shell arguments, shell
   tracing or the manifest. Run the local preparation helper, for example:

   ```bash
   TRADING_MODE=paper python scripts/prepare_runtime_handoff.py \
     --source-zip /dev/shm/nate-paper-handoff/runtime.zip \
     --source-sha "$SOURCE_RELEASE_SHA" \
     --source-run-id "$SOURCE_RUN_ID" \
     --source-artifact-id "$SOURCE_ARTIFACT_ID" \
     --target-sha "$TARGET_MERGE_SHA" \
     --output /dev/shm/nate-paper-handoff/manifest.json
   ```

   The ZIP may instead arrive on stdin with `--source-zip -`. The helper refuses
   an existing output file, non-private/non-tmpfs paths, a dirty or untracked
   identity source, an invalid canonical gate, ambiguous order history, mismatched
   account identity or an inconsistent broker snapshot. Success prints only
   PASS, the manifest digest and attempt/target counts. It creates a compact JSON
   file without a trailing newline; those exact bytes must survive approval.
   For the bounded second transfer described below, the source ZIP has exactly
   seven files and this command also requires
   `--prior-manifest-sha256 "$PREVIOUS_APPROVED_MANIFEST_SHA256"`. Obtain that
   digest from the existing external approval and verify its stored manifest
   body; do not derive a new approval from the archive's own manifest. Passing
   this option for a three-file first transfer is refused.
4. Review the resulting manifest against the intended source, final target,
   paper account and unchanged ranking universe. The source run must be no more
   than 96 hours old. Initial adoption has a maximum **48-hour** approval window
   and requires the current rebalance month. The 48-hour window accommodates
   Sunday preparation followed by Monday's scheduled cycle; it does not justify
   executing an order merely to keep the approval alive. An expired or stale
   bootstrap requires a fresh preparation and explicit review.

Preparation performs no GitHub write, workflow dispatch, approval, issue/comment
creation, broker submission or cancellation. It writes only the local review
artifact. A failed check is not permission to repair or replace frozen intent.

## Explicit promotion and preflight

The deployment owner updates three protected `paper-production` variables:

| Variable | Exact approved value |
| --- | --- |
| `PRODUCTION_RELEASE_SHA` | Final target merge SHA with successful release gate |
| `PAPER_RUNTIME_HANDOFF_MANIFEST` | Unmodified UTF-8 content of the reviewed local JSON file |
| `PAPER_RUNTIME_HANDOFF_SHA256` | SHA-256 of those exact bytes |

Use the environment-variable API's structured JSON input for the manifest body,
for example a private request file passed to `gh api --input`. Do not interpolate
the manifest into shell code or pretty-print/re-serialize its inner JSON. The
request envelope's `value` string must decode to the exact original manifest
bytes. Verify the stored value's digest without printing the value. Configuring
these variables is an explicit operator action; neither preparation nor restore
does it automatically.

Read and retain the expected old release, manifest bytes and digest before any
update. For a second transfer, replace the existing manifest and digest, verify
both readbacks, and set `PRODUCTION_RELEASE_SHA` **last**. Preserve every other
variable. These API updates are not one transaction: an interrupted update must
be inspected before retrying, and a temporarily mismatched release/pin must fail
closed. Inspect the actual environment protection rules; branch protection alone
does not imply a separate required-reviewer approval step.

After approval, dispatch the existing `paper-production.yml` from the trusted
default branch with **`operation=preflight`**. This checks out the exact approved
release, restores the state under the shared concurrency lock, performs normal
release/broker preflight and runs the read-only strategy preview. It performs no
paper execution and does not upload a fake target execution report. Manual
preflight failures do not open GitHub incidents. The first actual cycle is the
normal schedule, or a separately authorized **`operation=execute`** dispatch.

Merging this workflow before promotion can intentionally pause the old approved
executor: a checkout missing the new cadence, restoration or runtime-generation
helper cannot satisfy the workflow. There is no legacy seed fallback. Plan this controlled gap and
complete approval within the reviewed bootstrap window. Existing broker orders
may fill during the gap; preparation and execution reconcile their actual state
without inventing replacement intent.

Do not clear the external SHA pin while a target runtime still carries the
handoff evidence. Successful native restoration no longer applies the initial
48-hour bootstrap deadline, but still validates that pin and the original bytes.
The first preflight does not manufacture a target artifact, so the first actual
target execution must still start within the initial approval window.

## What restoration proves

The loader checks the repository name and numeric identity, trusted default
branch, exact paper workflow identity/path, source run and artifact, archive
digest, execution/upload step windows and release namespace. It accepts only
attempt 1: GitHub's artifact metadata identifies a run, not an execution attempt,
so a rerun cannot silently inherit another attempt's artifact. API pagination is
bounded to 1,000 objects per listing and must be complete; an ambiguous or larger
history fails closed. The implementation uses the
[Actions artifact API](https://docs.github.com/en/rest/actions/artifacts) and
[attempt-scoped jobs API](https://docs.github.com/en/rest/actions/workflow-jobs).

Every later or still-pending execution is considered, including an older queued
run that executed later. A newer failed/cancelled attempt without a valid runtime
artifact blocks restoration. The newest existing target artifact is always
authoritative; an expired, malformed or incorrectly attributed target artifact
never falls back to source, an older PASS or the checkout's seed. A valid latest
failed target with `FAIL` or `DEGRADED` summary is restored so pending broker
intent survives.

Archives are bounded before extraction: 20 MiB compressed, 32 MiB total inflated,
16 MiB per file and at most 32 members. Duplicates, traversal, symlinks, encrypted
members and unexpected files are rejected. No archive member is extracted by
`unzip`. The initial source must contain exactly:

```text
performance.json
positions.json
production/last_run.json
```

All three active files remain byte-identical during bootstrap, including the
truthful old `last_run` release. The loader also installs:

```text
production/handoff/manifest.json
production/handoff/source/performance.json
production/handoff/source/positions.json
production/handoff/source/production/last_run.json
```

Subsequent native artifacts preserve these originals. A native artifact still
carrying the old source `last_run` is accepted only with the pinned manifest,
complete original snapshot and unchanged active source bytes. A true target
execution writes the target `last_run` through the ordinary production runner.
Neither restoration nor a manual preflight relabels a historical execution.

The executor grants adoption only for the duration of a run, before even the
mutating safety preflights. It reads the paper account, every original and
current attempt, and two matching open-order and position-quantity snapshots.
An original submitted order must resolve by its exact broker/client IDs. A new
target reservation can resolve to a matching order or an actual HTTP 404; the
handoff does not rewrite or resubmit it. Existing retry rules then reconcile the
same client ID again. Unknown orders, mismatched quantities, transitional or
unknown statuses, and changing snapshots stop the run without a broker write.

Both early BUY reconciliation and later plan validation use this exact
authorization. A different native target identity alone cannot replace the
unfinished plan in the same month. A native successor also needs a truthful
target run record and existing strategy transition evidence: completed monthly
state, a later rebalance month, a latched zero-target risk exit, or the exact
CAUTIOUS halving with the original signal and constituents. Adoption never
overrides the market gate, CAUTIOUS, HALT, or normal risk-reducing behavior.
Historical performance/epoch fields and the original evidence remain intact.

## Bounded second transfer

A manifest with `schema_version: 2` can carry the same original unfinished plan
from a genuine first-target runtime into one further approved release. Its
source must contain the exact seven-file first-transfer archive above, with a
truthful source-release `last_run`. The new manifest binds all seven raw files
and adds `prior_handoff.manifest_sha256`, the separately approved first manifest
digest. The embedded prior manifest must be version 1; a third transfer is
refused. A completed or different native successor plan is not a substitute
source for this procedure.

The original account, ranking universe, plan identity and immutable plan fields
must remain the same. Original attempt records cannot disappear, regress their
counters or change their intent. Preparation and adoption reconcile both the
original and the latest source attempts with fresh broker GETs. An advanced
attempt requires evidence that the replaced order was canceled, expired or
rejected; an active or filled original cannot justify that retry.

The new active archive has exactly **eleven files**: the three unchanged current
source files, the new `production/handoff/manifest.json`, and all seven source
files preserved under `production/handoff/source/`. This retains the first
manifest and its original snapshot one level deeper, byte for byte. The new
external digest is required by both the workflow and the dashboard; it does not
replace or rewrite the prior digest inside the retained evidence. Subsequent
native publications keep all eleven files. Missing evidence cannot fall back to
a seven-file archive or a repository seed.

All files are staged before installation. A final source/latest-attempt check
runs immediately before the state-directory swap; a failed swap restores the
previous directory. API tokens stay in memory, Authorization is never forwarded
to the signed download host, and the CLI prints only a fixed PASS/FAIL result.

## Cycle results and coherent publication

The producer's `status` describes process health. The additive
`cycle_outcome` explicitly describes the trading cycle; neither a PASS nor a
submitted-order count proves that orders filled.

| Cycle state | Meaning | Producer health |
| --- | --- | --- |
| `completed` | The executor observed rebalance convergence | `PASS` |
| `idle` | No rebalance is due | `PASS` |
| `pending` | Orders, cancellation or reconciliation still need a later observation | `PASS` |
| `blocked` | An exposure gate, incomplete path or execution guard stopped progress | `DEGRADED` |
| `failed` | Execution, snapshot capture or publication failed | `FAIL` |

Legacy reports without this field remain explicitly unknown; the dashboard does
not infer completion from their health or action counts. Forward performance
keeps its original epoch and account/release eligibility checks. A handoff does
not manufacture an eligible history when those checks cannot establish one.

New publications put a shared `runtime_generation_id` in both snapshot files and
a `runtime_generation` record in `last_run`. That record binds their exact raw
SHA-256 digests, release, GitHub run ID and attempt. The producer stages all three
files and publishes `last_run` last. A partial replacement therefore fails byte
verification instead of presenting mixed snapshots as a healthy generation.
This proves file-publication coherence; it does not make separate broker HTTP
reads atomic. A recovery snapshot is explicitly `FAIL`, preserves available
intent, and makes no claim of a fresh portfolio observation.

The paper workflow verifies the generation against its own current run before
uploading runtime state:

```bash
python scripts/runtime_generation.py verify \
  --require-generation --require-current-run --state-dir state
```

An early failure or skipped execution cannot upload a stale restored report.
Restore and dashboard readers still accept entirely unmarked legacy snapshots
under their existing lineage rules, with no new coherence proof. Once any new
generation field appears, the complete contract and all byte hashes are required.

## Missing-session watchdog

The primary paper schedule remains 15:05 UTC on weekdays. A separate watchdog
checks at 15:35 through 19:35 UTC and permits recovery only inside the weekday
15:35–19:45 UTC window. It has no broker credentials and can dispatch only the
existing paper workflow with `operation=execute` and `automated_recovery=true`.
This is an automatic paper-order path through the ordinary protected release,
restore, preflight and risk checks; enabling its workflow does not authorize live
trading.

Both scheduled and recovery executions use the same production concurrency
group. The day guard runs before restoration and suppresses duplicate automatic
sessions. Any actual execution attempt counts, including failed or canceled
ones; the watchdog does not retry it or equate it with filled orders. A trusted,
completed run whose execution step is explicitly `skipped` may repeat the
read-only checks. Missing or ambiguous execution metadata stops recovery. This
lets a late queued cron recover from a preceding read-only restore failure
without discarding the latest-attempt checks in runtime restoration.

`python ops/paper_cadence.py check` performs GitHub reads only. `recover` can
dispatch a real paper cycle and is an operational mutation. An intentional
manual `operation=execute` with `automated_recovery=false` is a separate operator
decision and bypasses automatic day deduplication; do not use it as an acceptance
probe.

## Acceptance evidence

Before promotion, run the runtime restore, handoff, preparation, execution-safety
and deployment tests, plus the target's required release checks. Key regressions
must continue to pass: failed/DEGRADED latest target restoration, newer failed
attempt without artifact refusal, preserved original source lineage, late
queued execution detection, expired bootstrap refusal, native handoff after
bootstrap expiry, source recheck races and ZIP/redirect rejection. Also cover
exact seven-to-eleven preservation, prior-pin and attempt continuity, a refused
third transfer, partial generation writes, current-run upload binding and the
late-cron/skipped-execution recovery race.

During the September 13 review, read-only metadata checks passed for source run
`34632965595`, artifact `10276747594`, repository ID `1219694107` and workflow ID
`325543753`. The artifact digest was
`a59fb3b84b6aea2151b5f96d054e3cca293d215799660d380d8fc443ca8f80f7`;
its creation time fell inside the successful upload step. These are dated review
observations, not permanent allowlists or proof that the same source remains
fresh at promotion. The restore workflow always checks again.
