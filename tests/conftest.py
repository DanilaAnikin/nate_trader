"""Shared pytest configuration.

Adds scripts/ to sys.path so test modules can import from the same
namespace the production code uses (`from utils import ...`, etc.).
"""

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


@pytest.fixture
def validation_clock_at_bar_boundary(monkeypatch):
    """Freeze the validation contract clock just after the cached bar boundary.

    WHY THIS EXISTS
    ---------------
    ``validation_report_contract_errors`` expires a report whose
    ``bar_snapshot_through_date`` is more than ``VALIDATION_MAX_AGE_DAYS`` (35)
    days old. That rule is correct and must stay.

    But the canonical test fixture derives that date from the *committed* bar
    cache, whose latest SPY session is fixed at whatever was last downloaded.
    So every contract test built on that fixture silently acquired a 35-day
    fuse: it passed for five weeks after each data refresh and then began
    failing, everywhere, for a reason that has nothing to do with the contract
    it was written to test. That fuse burned down on 2026-08-15, taking four
    tests and the whole release gate with it — on ``main``, with no code change.

    A test whose verdict depends on the wall clock is not testing the property
    it claims to test. Freezing "now" one day past the fixture's own boundary
    restores the intended subject: given a report generated at its snapshot
    date, does the contract accept it?

    This deliberately does NOT weaken expiry coverage.
    ``test_validation_artifact_expires_even_when_digest_is_valid`` pins its
    dates to 2020-01-01, which is still far outside the window under the frozen
    clock, so it keeps failing exactly as it should.

    It also does not touch the live gate. The committed artifact in
    ``state/backtest/v11_validation.json`` stays expired until the bar cache is
    refreshed and validation is regenerated, which is a deliberate operator
    action with live-exposure consequences.
    """

    from datetime import datetime, timedelta, timezone

    from backtest import validate_v11
    from backtest.data_provider import BarProvider

    boundary = validate_v11.resolve_periods(BarProvider()).temporal_check_end
    frozen = datetime.strptime(str(boundary), "%Y-%m-%d").replace(
        hour=12, tzinfo=timezone.utc
    ) + timedelta(days=1)

    class _FrozenDatetime(datetime):
        """Delegates everything except ``now``/``utcnow`` to the real class."""

        @classmethod
        def now(cls, tz=None):
            return frozen.astimezone(tz) if tz else frozen.replace(tzinfo=None)

        @classmethod
        def utcnow(cls):
            return frozen.replace(tzinfo=None)

    monkeypatch.setattr(validate_v11, "datetime", _FrozenDatetime)

    # The factory stamps ``generated_at`` from its OWN ``datetime`` import
    # (tests/v11_report_factory.py:146), so patching only the contract module
    # leaves the report dated at the real wall clock — which the frozen
    # contract then rejects as future-dated. Both clocks have to move together
    # or the fixture just trades one time-dependent failure for another.
    try:
        from tests import v11_report_factory

        monkeypatch.setattr(v11_report_factory, "datetime", _FrozenDatetime)
    except ImportError:  # pragma: no cover - factory always present in-tree
        pass

    return frozen
