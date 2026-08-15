"""The test clock must never reach the production validation path.

PR #62 introduced `validation_clock_at_bar_boundary`, a fixture that freezes the
contract clock so four contract tests stop expiring with the calendar. That is
legitimate *inside a test measuring a contract*, and catastrophic if it ever
leaks into the code that decides whether the strategy may trade.

These four regressions pin the boundary. Each one fails if the separation is
weakened, and none of them depends on what day it is run.
"""

from __future__ import annotations

import inspect
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backtest import validate_v11
from sanity_check import check_validation_artifact
from tests.v11_report_factory import canonical_validation_report


def _report_with_boundary(days_old: int) -> dict:
    """A structurally valid report whose evidence is `days_old` days stale."""
    report = canonical_validation_report()
    stamp = datetime.now(timezone.utc) - timedelta(days=days_old)
    report["generated_at"] = stamp.isoformat()
    report["evidence"]["bar_snapshot_through_date"] = stamp.date().isoformat()
    return validate_v11.attach_report_contract(report)


# ── 1. production validation reads the real clock ───────────────────────────


def test_contract_uses_the_real_clock_when_no_now_is_supplied():
    """With no fixture and no `now=`, the contract must consult the real clock.

    If someone ever hard-codes a default, or leaves a frozen clock installed at
    import time, a report generated far in the past would stop looking old and
    this assertion is the thing that notices.
    """
    stale = _report_with_boundary(validate_v11.VALIDATION_MAX_AGE_DAYS + 30)
    errors = validate_v11.validation_report_contract_errors(stale)
    assert any("expired" in e for e in errors), (
        "a report generated well outside the age window was not reported as "
        f"expired under the real clock; errors were {errors!r}"
    )

    # and the default really is `datetime.now`, not a captured constant
    source = inspect.getsource(validate_v11.validation_report_contract_errors)
    assert "now or datetime.now(timezone.utc)" in source, (
        "the contract no longer defaults to the real current time"
    )


# ── 2. deliberate expiry is still detected ──────────────────────────────────


def test_the_age_window_is_pinned_at_thirty_five_days():
    """The window itself is the policy, so pin the number.

    This assertion exists because the obvious version of the boundary test
    below does NOT catch a widened window: it derives its "outside" case from
    VALIDATION_MAX_AGE_DAYS, so raising the constant to 3650 simply moves the
    test with it and the suite stays green. Measured — that is exactly what
    happened when this file was first written. A relative test can only find an
    off-by-one; only an absolute pin finds a policy change.

    Changing this number is a deliberate decision about how long stale evidence
    may authorize trading. It should require editing this line and explaining
    why in review, never a quiet constant bump.
    """
    assert validate_v11.VALIDATION_MAX_AGE_DAYS == 35


def test_expiry_is_still_detected_at_the_documented_boundary():
    """Just inside the window passes; just outside it fails."""
    inside = validate_v11.validation_report_contract_errors(
        _report_with_boundary(1)
    )
    assert not any("expired" in e for e in inside), (
        f"a one-day-old report was rejected as expired: {inside!r}"
    )

    outside = validate_v11.validation_report_contract_errors(
        _report_with_boundary(validate_v11.VALIDATION_MAX_AGE_DAYS + 1)
    )
    assert any("expired" in e for e in outside), (
        "a report one day past the window was not reported as expired: "
        f"{outside!r}"
    )


# ── 3. a stale artifact cannot become paper-authorizing ─────────────────────


def test_stale_artifact_can_never_authorize_paper(tmp_path):
    """The production entry point must refuse a stale artifact.

    Note this deliberately does NOT assert anything about the artifact
    currently committed in state/. That value changes when data is refreshed,
    and a test pinned to it would itself expire — the mistake this whole file
    exists to prevent. The property is about staleness, so the fixture is
    synthetic and the clock is real.
    """
    path = tmp_path / "validation.json"
    path.write_text(
        json.dumps(_report_with_boundary(validate_v11.VALIDATION_MAX_AGE_DAYS + 5))
    )

    failures = check_validation_artifact(path)
    assert failures, "a stale artifact produced no failures at all"
    assert any("expired" in f for f in failures), (
        f"staleness was not among the reported reasons: {failures!r}"
    )


# ── 4. the test clock cannot reach production ───────────────────────────────


def test_clock_fixture_is_opt_in_and_absent_here():
    """This test does not request the fixture, so the real class must be live.

    If `validation_clock_at_bar_boundary` were ever made autouse, every test in
    the suite would silently run against a frozen clock — including the three
    above, which would then prove nothing. That change would turn this red.
    """
    assert validate_v11.datetime is datetime, (
        "backtest.validate_v11.datetime has been replaced outside a test that "
        "asked for it — the clock fixture has leaked"
    )


def test_no_production_module_imports_the_test_clock():
    """Nothing under scripts/ may reach the fixture or a clock-injection hook.

    A grep, deliberately, over the real tree: the fixture lives in
    tests/conftest.py and must stay there. Production code importing anything
    from `tests` would make the frozen clock reachable from the path that
    authorizes trading.
    """
    scripts = Path(__file__).resolve().parent.parent / "scripts"
    sources = sorted(scripts.rglob("*.py"))

    # non-vacuity: a walker that found nothing would make this trivially true
    assert len(sources) > 15, f"only found {len(sources)} files under scripts/"

    offences = []
    for path in sources:
        text = path.read_text(encoding="utf-8", errors="replace")
        for needle in (
            "validation_clock_at_bar_boundary",
            "from tests",
            "import tests",
            "_FrozenDatetime",
        ):
            if needle in text:
                offences.append(f"{path.name}: references {needle!r}")
    assert offences == [], (
        "production code can reach test-only clock machinery: " + "; ".join(offences)
    )


@pytest.mark.parametrize("days_old", [0, 1, 10, 34])
def test_fresh_boundaries_are_not_rejected_as_expired(days_old):
    """Guards the other direction: the window must not be silently narrowed.

    Without this, "make expiry stricter" would look like a safe hardening
    change right up until it closed the gate on a perfectly current artifact.
    """
    errors = validate_v11.validation_report_contract_errors(
        _report_with_boundary(days_old)
    )
    assert not any("expired" in e for e in errors), (
        f"a {days_old}-day-old report was rejected as expired: {errors!r}"
    )
