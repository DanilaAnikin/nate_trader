"""Every copy of the shipped policy must agree with the policy itself.

`_V11_POLICY` is mirrored in four places, each written for a different reader:

  scripts/strategy_config.py        the policy itself, the only source of truth
  scripts/sanity_check.py           the offline release contract
  scripts/production_preflight.py   the last gate before an order is submitted
  dashboard/lib/v11-policy.json     what the operator is shown

Changing two numbers on 2026-09-08 broke three of them, and each was caught at
a different stage — one by the local test suite, one by CI, and the preflight
mirror only by a dispatched production run reaching the broker. Every one of
those was a separate round trip that a single test could have collapsed into
one failure at the moment of the edit.

So this asserts the mirrors against the policy rather than against literals.
Pinning a number here would just create a fifth mirror to forget.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from strategy_config import get_strategy_params

ROOT = Path(__file__).resolve().parent.parent

# The fields whose drift would change what the strategy actually does, as
# opposed to how it is described. Each has to appear in every mirror that
# claims to check the policy.
LOAD_BEARING = (
    "momentum_top_n",
    "max_position_pct",
    "momentum_max_sector_pct",
    "min_cash_pct",
    "momentum_below_sma200_floor_pct",
)


@pytest.fixture(scope="module")
def policy() -> dict:
    return get_strategy_params("BULL", "NORMAL")


def _numbers_asserted_in(source: str, keys) -> dict[str, float]:
    """Pull `"key": <number>` / `"key" == <number>` pairs out of a source file.

    Deliberately textual. The point is to read what each mirror ASSERTS, which
    a normal import cannot see — the assertion is the thing under test.
    """
    found: dict[str, float] = {}
    for key in keys:
        match = re.search(
            rf'["\']{re.escape(key)}["\']\s*(?::|==)\s*([0-9]+(?:\.[0-9]+)?)', source
        )
        if match:
            found[key] = float(match.group(1))
    return found


def test_the_offline_release_contract_matches_the_policy(policy):
    source = (ROOT / "scripts" / "sanity_check.py").read_text()
    asserted = _numbers_asserted_in(source, LOAD_BEARING)
    assert asserted, "sanity_check asserts no policy numbers at all"
    for key, value in asserted.items():
        assert value == policy[key], f"sanity_check expects {key}={value}, policy says {policy[key]}"


def test_the_broker_preflight_matches_the_policy(policy):
    source = (ROOT / "scripts" / "production_preflight.py").read_text()
    asserted = _numbers_asserted_in(source, LOAD_BEARING)
    assert asserted, "production_preflight asserts no policy numbers at all"
    for key, value in asserted.items():
        assert value == policy[key], (
            f"production_preflight expects {key}={value}, policy says {policy[key]}"
        )


def test_the_dashboard_mirror_matches_the_policy(policy):
    published = json.loads((ROOT / "dashboard" / "lib" / "v11-policy.json").read_text())
    pairs = {
        "topN": "momentum_top_n",
        "maxPositionPct": "max_position_pct",
        "maxSectorPct": "momentum_max_sector_pct",
        "minCashPct": "min_cash_pct",
        "belowSma200FloorPct": "momentum_below_sma200_floor_pct",
    }
    for shown, key in pairs.items():
        assert shown in published, f"the dashboard does not publish {shown}"
        assert float(published[shown]) == float(policy[key]), (
            f"dashboard shows {shown}={published[shown]}, policy says {key}={policy[key]}"
        )


def test_every_load_bearing_field_is_checked_somewhere_before_an_order(policy):
    """A field nobody asserts can drift the whole way to the broker.

    The preflight is the last gate before a submission, so it is the one that
    has to cover them all.
    """
    source = (ROOT / "scripts" / "production_preflight.py").read_text()
    asserted = _numbers_asserted_in(source, LOAD_BEARING)
    missing = [key for key in LOAD_BEARING if key not in asserted]
    assert not missing, f"the broker preflight asserts nothing about {missing}"


def test_a_drifting_mirror_names_the_field_it_disagrees_with():
    """A mismatch has to say WHICH field, not just that something is wrong.

    The preflight originally reported only "breadth-scaled top-10 policy" on
    failure, so a real drift cost a dive through a production run's log to find
    out which of seven values had moved.
    """
    source = (ROOT / "scripts" / "production_preflight.py").read_text()
    assert "policy drift:" in source
    assert "expected" in source
