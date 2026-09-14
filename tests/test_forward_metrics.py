"""Observed paper fills are evidence; submitted orders and costs are not fills."""

import importlib.util
import json
from copy import deepcopy
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "forward_metrics", Path(__file__).resolve().parents[1] / "ops/forward_metrics.py"
)
metrics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(metrics)


def fill(identity="event-1", order="order-1", symbol="AAA", side="buy",
         qty="2", price="99", **changes):
    return {"id": identity, "activity_type": "FILL", "type": "partial_fill",
            "transaction_time": "2026-09-15T16:00:00Z", "order_id": order,
            "symbol": symbol, "side": side, "qty": qty, "price": price, **changes}


def order(identity="order-1", symbol="AAA", side="buy", **changes):
    return {"id": identity, "symbol": symbol, "side": side, "type": "limit",
            "qty": "10", "filled_qty": "2", "limit_price": "100",
            "status": "partially_filled", **changes}


def activity(kind, amount, identity="nontrade-1", **changes):
    return {"id": identity, "activity_type": kind, "date": "2026-09-15",
            "net_amount": amount, **changes}


def observations():
    return [{"date": day, "observed_at": f"{day}T20:30:00Z", "equity": value}
            for day, value in [("2026-09-15", 1000), ("2026-09-16", 1100),
                               ("2026-09-17", 990), ("2026-09-18", 1050)]]


def summarize(activities=None, orders=None, equity=None, **changes):
    return metrics.summarize_forward_observations(
        activities=[] if activities is None else activities,
        orders_by_id={} if orders is None else orders,
        equity_observations=observations() if equity is None else equity,
        window_start="2026-09-14T21:00:00Z", window_end="2026-09-18T21:00:00Z",
        activities_complete=True, **changes,
    )


def test_submitted_or_even_filled_order_does_not_invent_a_fill_activity():
    for status in ("new", "filled"):
        result = summarize(orders={"order-1": order(status=status, filled_qty="10")})
        assert result["fills"]["event_count"] == 0
        assert result["fills"]["orders_with_observed_fills_by_status"] == {}
        assert result["fills"]["fill_vs_limit"]["signed_bps"] is None
        assert result["fees"]["observed_net_debit"] is None
        assert result["fees"]["final_total"] is None


def test_incremental_partial_fills_are_deduplicated_not_cumulative_or_discarded_on_cancel():
    first = fill(qty="2", cum_qty="2", leaves_qty="8")
    second = fill("event-2", qty="3", price="100", cum_qty="5", leaves_qty="5")
    rows = [first, second, deepcopy(first)]
    original = deepcopy(rows)
    result = summarize(rows, {"order-1": order(status="canceled", filled_qty="5")})
    assert rows == original
    assert result["coverage"]["duplicate_count"] == 1
    fills = result["fills"]
    assert fills["event_count"] == 2
    assert fills["order_count"] == 1
    assert fills["quantity_by_symbol_and_side"] == [{"symbol": "AAA", "side": "buy", "qty": 5}]
    assert fills["notional"] == 498
    assert fills["orders_with_observed_fills_by_status"] == {"canceled": 1}


def test_limit_delta_has_correct_side_sign_and_notional_weighting_not_claimed_slippage():
    rows = [fill(qty="1", price="101"), fill("event-2", "order-2", "BBB", "sell", "2", "198")]
    orders = {"order-1": order(filled_qty="1"),
              "order-2": order("order-2", "BBB", "sell", limit_price="200")}
    result = summarize(rows, orders)["fills"]
    assert len(result["quantity_by_symbol_and_side"]) == 2
    assert "qty" not in result  # Shares of different symbols are not summed.
    assert result["fill_vs_limit"]["reference_notional"] == 500
    assert result["fill_vs_limit"]["signed_delta"] == 5
    assert result["fill_vs_limit"]["signed_bps"] == 100
    for reference in ("decision_slippage", "arrival_slippage"):
        assert result[reference]["status"] == "UNAVAILABLE"
        assert result[reference]["bps"] is None


@pytest.mark.parametrize("patch", [{"limit_price": None}, {"type": "market"}, {"limit_price": "NaN"}])
def test_missing_limit_reference_withholds_only_the_limit_metric(patch):
    result = summarize([fill()], {"order-1": order(**patch)})["fills"]
    assert result["event_count"] == 1
    assert result["fill_vs_limit"]["status"] == "UNAVAILABLE"
    assert result["fill_vs_limit"]["signed_delta"] is None


def test_partial_reference_coverage_is_explicit_and_does_not_drop_unmatched_fills():
    rows = [fill(), fill("event-2", "missing", "BBB", "sell", "1", "50")]
    result = summarize(rows, {"order-1": order()})["fills"]
    assert result["notional"] == 248
    assert result["missing_order_count"] == 1
    assert result["fill_vs_limit"]["status"] == "PARTIAL"
    assert result["fill_vs_limit"]["covered_fill_count"] == 1
    assert result["fill_vs_limit"]["total_fill_count"] == 2


@pytest.mark.parametrize("patch", [
    {"id": "another"}, {"symbol": "BBB"}, {"side": "sell"},
    {"filled_qty": "1"}, {"filled_qty": "11"}, {"status": "future_status"},
    {"status": "filled", "filled_qty": "2"},
])
def test_inconsistent_order_snapshot_is_not_a_reference_or_a_reason_to_erase_fill(patch):
    result = summarize([fill()], {"order-1": order(**patch)})["fills"]
    assert result["event_count"] == 1
    assert result["inconsistent_order_count"] == 1
    assert result["orders_with_observed_fills_by_status"] == {}
    assert result["fill_vs_limit"]["status"] == "UNAVAILABLE"


def test_late_fee_and_rebate_update_observed_debit_without_inventing_final_cost_or_trade_attribution():
    before = summarize([fill()])
    late_fee = activity("FEE", "-0.04", created_at="2026-09-16T01:00:00Z")
    after = summarize([fill(), late_fee, activity("PTR", "0.01", "rebate")])
    assert before["fees"]["status"] == "UNKNOWN"
    assert before["fees"]["observed_net_debit"] is None
    assert after["fees"]["observed_activity_count"] == 2
    assert after["fees"]["observed_net_debit"] == pytest.approx(0.03)
    assert after["fees"]["final_total"] is None
    assert after["equity"]["flow_adjusted_drawdown_pct"] == 10
    assert after["scope"] == "account_not_strategy_attributed"


def test_crypto_fee_of_unknown_currency_is_not_added_to_cash_fees():
    result = summarize([activity("CFEE", "-0.001")])
    assert result["fees"]["observed_net_debit"] is None
    assert result["coverage"]["unclassified_activity_count"] == 1
    assert result["equity"]["flow_adjusted_drawdown_pct"] is None


@pytest.mark.parametrize("row", [activity("CSD", "100"), activity("CSW", "-100"),
                                     activity("JNL", "100"), activity("NEW_TYPE", "100"),
                                     activity("JNLS", "0")])
def test_external_or_unknown_flow_preserves_raw_drawdown_but_withholds_adjusted_claim(row):
    result = summarize([row])["equity"]
    assert result["observed_account_drawdown_pct"] == 10
    assert result["flow_adjusted_drawdown_pct"] is None
    assert result["flow_adjustment_status"] == "UNAVAILABLE"


def test_date_only_row_crossing_intraday_boundary_is_not_assigned_to_window():
    result = summarize([activity("FEE", "-5", date="2026-09-14")])
    assert result["coverage"]["boundary_ambiguous_count"] == 1
    assert result["fees"]["observed_net_debit"] is None
    assert result["equity"]["flow_adjusted_drawdown_pct"] is None


def test_old_execution_is_excluded_even_if_created_after_forward_window_start():
    result = summarize([fill(transaction_time="2026-08-11T16:00:00Z",
                             created_at="2026-09-16T00:00:00Z")])
    assert result["coverage"]["outside_window_count"] == 1
    assert result["fills"]["event_count"] == 0


def test_incomplete_activity_walk_keeps_observations_but_not_flow_adjusted_drawdown():
    result = metrics.summarize_forward_observations(
        activities=[fill()], orders_by_id={}, equity_observations=observations(),
        window_start="2026-09-14T21:00:00Z", window_end="2026-09-18T21:00:00Z",
        activities_complete=False)
    assert result["fills"]["event_count"] == 1
    assert result["coverage"]["activities_complete"] is False
    assert result["equity"]["flow_adjusted_drawdown_pct"] is None


def test_daily_observations_use_latest_per_ny_date_not_intraday_sample_extrema():
    equity = observations()
    equity.append({"date": "2026-09-17", "observed_at": "2026-09-17T15:00:00Z", "equity": 500})
    result = summarize(equity=equity)["equity"]
    assert result["daily_observation_count"] == 4
    assert result["observed_account_drawdown_pct"] == 10
    assert "not_intraday_maximum" in result["scope"]


@pytest.mark.parametrize("equity", [[], observations()[:1], [
    {"date": "2026-09-15", "observed_at": "2026-09-15T16:00:00Z", "equity": 0},
    {"date": "2026-09-16", "observed_at": "2026-09-16T16:00:00Z", "equity": 0},
]])
def test_no_invented_zero_drawdown_without_two_positive_observations(equity):
    result = summarize(equity=equity)["equity"]
    assert result["observed_account_drawdown_pct"] is None


def test_duplicate_correction_is_refused_with_fixed_error_and_no_sensitive_body():
    first = fill(description="PRIVATE_ACCOUNT_SENTINEL")
    second = {**first, "price": "100"}
    with pytest.raises(metrics.ForwardMetricsError, match="^activity_duplicate_conflict$") as caught:
        summarize([first, second])
    assert "PRIVATE" not in str(caught.value)
    output = json.dumps(summarize([first]))
    assert "PRIVATE" not in output and "order-1" not in output and "event-1" not in output


@pytest.mark.parametrize("patch", [{"qty": "NaN"}, {"price": float("inf")},
                                   {"qty": True}, {"price": "-1"}, {"qty": "0"},
                                   {"cum_qty": "1"}, {"leaves_qty": "-1"},
                                   {"type": "trade_bust"}])
def test_malformed_fill_is_not_silently_skipped(patch):
    with pytest.raises(metrics.ForwardMetricsError):
        summarize([fill(**patch)])


def test_conflicting_equity_duplicate_and_wrong_session_date_are_refused():
    rows = observations()
    for extra in ({**rows[0], "equity": 999}, {**rows[0], "date": "2026-09-14"}):
        with pytest.raises(metrics.ForwardMetricsError):
            summarize(equity=[*rows, extra])


def test_live_mode_and_implicit_naive_window_are_not_accepted():
    with pytest.raises(metrics.ForwardMetricsError, match="paper_coverage_required"):
        summarize(mode="live")
    with pytest.raises(metrics.ForwardMetricsError, match="timestamp_invalid"):
        metrics.stamp("2026-09-14T21:00:00")
