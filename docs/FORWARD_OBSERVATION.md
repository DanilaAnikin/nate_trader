# Paper observations and live readiness

The observer runs on the production host independently of GitHub scheduling.
It reads GitHub execution metadata and the configured paper broker account.
It has no order, cancellation, transfer, workflow-dispatch or notification path.
It does not modify the strategy, its historical forward epoch, or its runtime.

## What the evidence means

- A natural paper execution requires the actual `schedule` event, verified
  repository/workflow/source, and a started execution step. A manual execution
  does not satisfy this check.
- A natural watchdog decision requires its own scheduled run and the structured
  decision inside the exact recovery step's timestamp window. A successful job
  alone does not prove that a recovery was required or dispatched.
- Recovery IDs are taken from that decision and checked against the corresponding
  paper run. The observer never guesses a nearby run or triggers a recovery.
- Orchestration `head_sha` and approved trading release are separate. Unchanged
  workflow bytes allow an observer-only commit on main while the executor still
  uses the approved release. Metadata is not proof of the portfolio outcome;
  the dashboard's runtime-generation validator remains responsible for that.
- Protected GitHub approval variables are independently verified only when the
  application token can read both values. An HTTP 403 on either of those two
  endpoints is recorded as `protected_approval_evidence.verified: false` and the
  collection is labelled `COLLECTED_WITH_LIMITED_APPROVAL_EVIDENCE`. The configured
  release remains an expected pin, not proof of current protected approval.
  Actual account, application and source bindings remain mandatory. Readable
  mismatches, other HTTP failures, or approval evidence changing during a
  collection fail that collection. No broader token is provisioned for this check.
- Actual paper FILL activities establish simulated executions, including partial
  fills. Attempt records or submitted order counts are not fills. Observations
  are scoped to the bound account, not attributed to a strategy without evidence.

The fixed activity retrieval boundary is older than the observation window.
Every collection walks it again with bounded, checked pagination because fees
and corrections can arrive later. Metrics include only the explicit new
observation window; old activity does not silently become a new forward result.
Alpaca's activity filters use creation time; execution time and date-only
non-trade activity dates require separate treatment. See the
[Alpaca activity API](https://docs.alpaca.markets/us/reference/getaccountactivities-2).

The report separates measured signed fill-price difference against an order's
limit from decision/arrival slippage. Those reference prices are not currently
recorded and are reported as unavailable. Absence of a fee record is not proof
of zero fees, and observed fees are not a final settled total.

Drawdown uses the latest collected equity sample for each New York calendar day.
At least two positive daily observations are needed; it is not the intraday
maximum. It describes the account. Flow-adjusted drawdown remains unavailable
without the necessary intraday cashflow valuations and atomic observations.

## Host installation

The production module is `ops.forward_observer` and uses the Python standard
library. Install the four `ops/forward_*.py` files from a reviewed immutable
commit under `/srv/homelab/nate-trader-observer/releases/<commit>/ops/`, owned
by root and not writable by other users. Point `current` at that release.

The root-owned mode-0600 file `/etc/nate-trader/forward-observer.json` contains:

| Field | Required binding |
|---|---|
| `schema_version` | Integer 1 |
| `app_container`, `app_sha`, `app_image` | Actual production container, full release SHA and immutable image ID |
| `approved_release_sha`, `paper_handoff_sha256` | Current protected paper approval and handoff pin |
| `activities_since` | Fixed RFC3339 retrieval boundary for late activity |
| `observed_since` | Fixed RFC3339 start of this observer's evidence window |
| `source_digests` | SHA256 of paper-production.yml, paper-watchdog.yml and ops/paper_cadence.py from the approved source |
| `state_directory` | `/var/lib/homelab/nate-trader/forward-observation` |

Create that state directory and its `observations` and `ledgers` subdirectories
root-owned mode 0700. Install the units from `ops/monitor/`, reload systemd and
enable `nt-forward-observer.timer`. Run the service once and inspect its actual
output before declaring the installation verified. `systemd-analyze calendar`
validates the UTC schedules: weekdays every half hour between 15:15 and 23:45,
plus a daily 08:15 sweep for late postings. This observes future sessions; it
cannot establish that a scheduled run happened before that run exists.

The service forbids swap and core dumps. Credentials are read through the
existing bound Vault RPC into RAM. Broker requests are hardcoded to the paper
origin and read endpoints. GitHub requests only read metadata, pinned source
bytes and logs; authorization is stripped from signed log downloads.
The host's network-namespace access reaches the existing private database
gateway. Neither public data-plane access nor new credentials are introduced.

## Private records and failures

All records are root-owned mode 0600. `latest.json` describes the most recent
attempt. `latest-success.json` retains the last completed collection but must
not be treated as current after a failed attempt. `ledger.json` and immutable
`ledgers/<sha256>.json` preserve actual activities, order observations and equity
samples; `observations/` preserves reports bound to their ledger hashes.
No broker credential is written into these files. These are private account
records and must not be committed to the public repository.
`latest-success.json` means a completed collection; inspect its status and
`protected_approval_evidence` before interpreting the scope of that evidence.

The journal prints only a fixed result and the report path. There is no email,
Slack or issue notification. A changed binding, truncated page, unknown evidence
or failed request produces a failed observation; the next timer can repeat this
read-only work without repeating an order. To stop collection, stop/disable the
timer and service. Retain the records; no trading process needs a rollback.

## Live preflight

Live diagnostics are separate from this paper service. The current budget is a
ceiling, not a deposit. A fresh, read-only check can verify credentials, account
binding, available funds and the existing production preflight without placing
orders. A zero-funded account legitimately fails fresh risk readiness. Such a
diagnostic neither provisions workflow credentials nor approves a live release,
restores a live runtime, or authorizes a real-money cycle.
