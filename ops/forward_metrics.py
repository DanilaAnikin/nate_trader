"""Pure account-scoped paper observations; never infer fills or execution costs.

The collector owns authentication, pagination and read-only provenance. Activity
query filters use creation time, whereas FILL.transaction_time and NTA.date
describe execution/settlement: repeatedly collect the full fixed history to see
late fees. No network, persistence, strategy attribution, or epoch mutation here.
Sources: https://docs.alpaca.markets/us/docs/account-activities and
https://docs.alpaca.markets/us/reference/getaccountactivities-2 .
"""

import json
import math
import re
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
EXTERNAL = {"CSD", "CSW", "JNLC", "ACATC", "WIRE"}
FEES = {"FEE", "CFEE", "DIVFEE", "PTC", "PTR"}
INTERNAL = FEES | {
    "DIV", "DIVCGL", "DIVCGS", "DIVFT", "DIVNRA", "DIVROC", "DIVTW",
    "DIVTXEX", "INT", "INTNRA", "INTTW", "CGD",
}
STATUSES = {
    "new", "accepted", "pending_new", "accepted_for_bidding", "partially_filled",
    "filled", "canceled", "cancelled", "expired", "rejected", "replaced",
    "done_for_day", "pending_cancel", "pending_replace", "stopped", "suspended",
    "calculated", "held",
}


class ForwardMetricsError(ValueError):
    """Fixed, non-sensitive input refusal codes only."""


def require(value, code):
    if not value:
        raise ForwardMetricsError(code)


def stamp(value):
    require(isinstance(value, str) and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value),
        "timestamp_invalid")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, OverflowError):
        raise ForwardMetricsError("timestamp_invalid") from None


def number(value, *, positive=False):
    require(type(value) in (str, int, float, Decimal), "number_invalid")
    try:
        result = Decimal(str(value))
        require(result.is_finite() and abs(result) < Decimal("1e20"), "number_invalid")
        require(not positive or result > 0, "number_not_positive")
        return result
    except InvalidOperation:
        raise ForwardMetricsError("number_invalid") from None


def scalar(value):
    result = float(value)
    require(math.isfinite(result), "aggregate_nonfinite")
    return result


def unique_activities(activities):
    require(isinstance(activities, list) and len(activities) <= 50000, "activities_shape")
    result, fingerprints, duplicates = [], {}, 0
    for row in activities:
        require(isinstance(row, dict) and isinstance(row.get("id"), str)
                and 0 < len(row["id"]) <= 256, "activity_identity_invalid")
        require(isinstance(row.get("activity_type"), str), "activity_type_invalid")
        try:
            fingerprint = json.dumps(row, sort_keys=True, allow_nan=False)
        except (ValueError, TypeError):
            raise ForwardMetricsError("activity_invalid") from None
        if row["id"] in fingerprints:
            require(fingerprints[row["id"]] == fingerprint, "activity_duplicate_conflict")
            duplicates += 1
            continue
        fingerprints[row["id"]] = fingerprint
        result.append(row)
    return result, duplicates


def activity_interval(row):
    if row["activity_type"] == "FILL":
        at = stamp(row.get("transaction_time"))
        return at, at
    value = row.get("date")
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        try:
            day = date.fromisoformat(value)
        except ValueError:
            raise ForwardMetricsError("activity_date_invalid") from None
        start = datetime.combine(day, time(), NY)
        return start, start + timedelta(days=1)
    at = stamp(value)
    return at, at


def fill_metrics(rows, orders):
    fills, quantity, notional = [], defaultdict(Decimal), Decimal(0)
    grouped = defaultdict(list)
    for row in rows:
        if row["activity_type"] != "FILL":
            continue
        require(row.get("type") in ("fill", "partial_fill"), "fill_type_invalid")
        symbol, side, order_id = row.get("symbol"), row.get("side"), row.get("order_id")
        require(isinstance(symbol, str) and re.fullmatch(r"[A-Z0-9./-]{1,24}", symbol)
                and side in ("buy", "sell") and isinstance(order_id, str)
                and 0 < len(order_id) <= 128, "fill_binding_invalid")
        qty, price = number(row.get("qty"), positive=True), number(row.get("price"), positive=True)
        if "cum_qty" in row:
            require(number(row["cum_qty"]) >= qty, "fill_cumulative_quantity_invalid")
        if "leaves_qty" in row:
            require(number(row["leaves_qty"]) >= 0, "fill_remaining_quantity_invalid")
        fills.append((order_id, symbol, side, qty, price))
        grouped[order_id].append(fills[-1])
        quantity[(symbol, side)] += qty
        notional += qty * price

    statuses, matched, missing, inconsistent = Counter(), {}, 0, 0
    for order_id, group in grouped.items():
        order = orders.get(order_id)
        if not isinstance(order, dict):
            missing += 1
            continue
        try:
            qty, filled = number(order.get("qty"), positive=True), number(order.get("filled_qty"))
            require(order.get("id") == order_id and isinstance(order.get("status"), str)
                    and order["status"] in STATUSES
                    and all((fill[1], fill[2]) == (order.get("symbol"), order.get("side")) for fill in group)
                    and sum((fill[3] for fill in group), Decimal(0)) <= filled <= qty
                    and (order["status"] != "filled" or filled == qty), "order_binding_invalid")
        except ForwardMetricsError:
            inconsistent += 1
            continue
        statuses[order["status"]] += 1
        matched[order_id] = order

    covered, reference, delta = 0, Decimal(0), Decimal(0)
    for order_id, _symbol, side, qty, price in fills:
        order = matched.get(order_id)
        if order is None or order.get("type") != "limit" or order.get("limit_price") is None:
            continue
        try:
            limit = number(order["limit_price"], positive=True)
        except ForwardMetricsError:
            continue
        covered += 1
        reference += qty * limit
        delta += qty * (price - limit if side == "buy" else limit - price)
    matched_fill_count = sum(1 for fill in fills if fill[0] in matched)
    return {
        "event_count": len(fills), "order_count": len({fill[0] for fill in fills}),
        "notional": scalar(notional),
        "quantity_by_symbol_and_side": [
            {"symbol": symbol, "side": side, "qty": scalar(qty)}
            for (symbol, side), qty in sorted(quantity.items())],
        "orders_with_observed_fills_by_status": dict(sorted(statuses.items())),
        "missing_order_count": missing, "inconsistent_order_count": inconsistent,
        "order_snapshot_coverage": {
            "status": "UNAVAILABLE" if not fills else
                      "COMPLETE" if matched_fill_count == len(fills) else "PARTIAL",
            "covered_fill_count": matched_fill_count,
            "total_fill_count": len(fills),
            "coverage_pct": scalar(Decimal(matched_fill_count) / Decimal(len(fills)) * 100)
                if fills else None,
            "meaning": "consistent order snapshots for observed FILL events; not submitted-order fill rate",
        },
        "fill_rate": {
            "status": "UNAVAILABLE",
            "rate_pct": None,
            "reason": "submitted_order_history_not_collected",
            "meaning": "execution fill rate requires all submitted orders, including orders with no FILL activity",
        },
        "decision_slippage": {"status": "UNAVAILABLE", "bps": None, "reason": "decision_reference_not_recorded"},
        "arrival_slippage": {"status": "UNAVAILABLE", "bps": None, "reason": "arrival_reference_not_recorded"},
        "fill_vs_limit": {
            "status": "UNAVAILABLE" if not covered else "COMPLETE" if covered == len(fills) else "PARTIAL",
            "covered_fill_count": covered, "total_fill_count": len(fills),
            "reference_notional": scalar(reference) if covered else None,
            "signed_delta": scalar(delta) if covered else None,
            "signed_bps": scalar(delta / reference * 10000) if covered else None,
            "meaning": "positive_is_worse_than_limit_not_arrival_or_decision_slippage",
        },
    }


def _session_return_metrics(values, dates, flow_uncertain):
    """Compute conservative observed-session Sharpe and Sortino ratios.

    The observer has account equity samples, not an exchange calendar. We only
    call these *session* statistics when every sample is a weekday and adjacent
    samples are separated by at most a long weekend (three calendar days). A
    missing weekday/holiday is therefore fail-closed instead of silently
    treating a multi-session return as one daily observation. External or
    unclassified cash activity also withholds the ratios because the sampled
    equity cannot be made time-weighted without an intraday valuation.
    """
    meaning = (
        "account-level observed-session return ratio; zero risk-free proxy; "
        "not strategy-attributed and not a guarantee"
    )
    if flow_uncertain:
        return {
            "status": "UNAVAILABLE",
            "reason": "external_or_unclassified_flow_or_incomplete_coverage",
            "observed_session_count": len(values),
            "return_observation_count": 0,
            "sharpe_ratio": None,
            "sortino_ratio": None,
            "annualization": "252 observed sessions per year",
            "risk_free_proxy": "ZERO",
            "meaning": meaning,
        }
    if len(values) < 3 or len(values) != len(dates):
        return {
            "status": "UNAVAILABLE",
            "reason": "insufficient_observations",
            "observed_session_count": len(values),
            "return_observation_count": 0,
            "sharpe_ratio": None,
            "sortino_ratio": None,
            "annualization": "252 observed sessions per year",
            "risk_free_proxy": "ZERO",
            "meaning": meaning,
        }
    parsed_dates = [date.fromisoformat(value) for value in dates]
    if any(day.weekday() > 4 for day in parsed_dates):
        reason = "non_session_observation"
    elif any((later - earlier).days not in (1, 2, 3)
             for earlier, later in zip(parsed_dates, parsed_dates[1:])):
        reason = "non_consecutive_sessions"
    elif any(value <= 0 for value in values):
        reason = "non_positive_equity"
    else:
        reason = None
    if reason is not None:
        return {
            "status": "UNAVAILABLE",
            "reason": reason,
            "observed_session_count": len(values),
            "return_observation_count": 0,
            "sharpe_ratio": None,
            "sortino_ratio": None,
            "annualization": "252 observed sessions per year",
            "risk_free_proxy": "ZERO",
            "meaning": meaning,
        }

    returns = [values[index] / values[index - 1] - 1
               for index in range(1, len(values))]
    mean = sum(returns, Decimal(0)) / Decimal(len(returns))
    # Sample standard deviation matches the canonical backtest Sharpe
    # definition and requires at least two return observations.
    if len(returns) < 2:
        return {
            "status": "UNAVAILABLE",
            "reason": "insufficient_return_observations",
            "observed_session_count": len(values),
            "return_observation_count": len(returns),
            "sharpe_ratio": None,
            "sortino_ratio": None,
            "annualization": "252 observed sessions per year",
            "risk_free_proxy": "ZERO",
            "meaning": meaning,
        }
    variance = sum((value - mean) ** 2 for value in returns) / Decimal(len(returns) - 1)
    std = variance.sqrt() if variance >= 0 else Decimal(0)
    downside = [min(value, Decimal(0)) for value in returns]
    downside_deviation = (sum(value ** 2 for value in downside) / Decimal(len(downside))).sqrt()
    annualization = Decimal(252).sqrt()
    sharpe = mean / std * annualization if std > 0 else None
    sortino = mean / downside_deviation * annualization if downside_deviation > 0 else None
    if sharpe is None and sortino is None:
        status, reason = "UNAVAILABLE", "zero_return_variance_and_no_downside"
    else:
        status, reason = "COMPLETE", None
    return {
        "status": status,
        "reason": reason,
        "observed_session_count": len(values),
        "return_observation_count": len(returns),
        "sharpe_ratio": scalar(sharpe) if sharpe is not None else None,
        "sortino_ratio": scalar(sortino) if sortino is not None else None,
        "annualization": "252 observed sessions per year",
        "risk_free_proxy": "ZERO",
        "meaning": meaning,
    }


def _turnover_metrics(gross, average_equity, flow_uncertain):
    """Report gross observed notional turnover only with a valid denominator."""
    meaning = (
        "gross account fill notional divided by average observed equity; "
        "includes buys and sells, is not strategy-attributed, and is not a fill rate"
    )
    if flow_uncertain:
        return {
            "status": "UNAVAILABLE",
            "reason": "external_or_unclassified_flow_or_incomplete_coverage",
            "gross_notional": scalar(gross),
            "average_observed_equity": None,
            "gross_turnover_pct": None,
            "meaning": meaning,
        }
    if average_equity is None or average_equity <= 0:
        return {
            "status": "UNAVAILABLE",
            "reason": "non_positive_or_missing_equity_denominator",
            "gross_notional": scalar(gross),
            "average_observed_equity": None,
            "gross_turnover_pct": None,
            "meaning": meaning,
        }
    average = average_equity
    turnover = gross / average * 100
    return {
        "status": "COMPLETE",
        "reason": None,
        "gross_notional": scalar(gross),
        "average_observed_equity": scalar(average),
        "gross_turnover_pct": scalar(turnover),
        "meaning": meaning,
    }


def equity_metrics(observations, start, end, flow_uncertain):
    require(isinstance(observations, list) and len(observations) <= 50000, "equity_shape")
    daily, seen = {}, {}
    for row in observations:
        require(isinstance(row, dict), "equity_shape")
        at, equity = stamp(row.get("observed_at")), number(row.get("equity"))
        require(equity >= 0 and row.get("date") == at.astimezone(NY).date().isoformat(), "equity_date_or_value_invalid")
        require(at not in seen or seen[at] == equity, "equity_duplicate_conflict")
        seen[at] = equity
        if start <= at <= end and (row["date"] not in daily or daily[row["date"]][0] < at):
            daily[row["date"]] = (at, equity)
    ordered = sorted(daily.items())
    values = [value for _, (_at, value) in ordered]
    dates = [day for day, (_at, _value) in ordered]
    drawdown = None
    average_equity = None
    if values and all(value > 0 for value in values):
        average_equity = sum(values, Decimal(0)) / Decimal(len(values))
    if len(values) >= 2 and all(value > 0 for value in values):
        peak, worst = values[0], Decimal(0)
        for value in values:
            peak = max(peak, value)
            worst = min(worst, value / peak - 1)
        drawdown = scalar(-worst * 100)
    return {"daily_observation_count": len(values),
            "first_observed_at": min(daily.values())[0].isoformat() if daily else None,
            "last_observed_at": max(daily.values())[0].isoformat() if daily else None,
            "average_observed_equity": scalar(average_equity) if average_equity is not None else None,
            "observed_account_drawdown_pct": drawdown,
            "flow_adjusted_drawdown_pct": None if flow_uncertain else drawdown,
            "flow_adjustment_status": "UNAVAILABLE" if flow_uncertain or drawdown is None else "NO_EXTERNAL_FLOW_OBSERVED",
            "reason": "external_or_unclassified_flow_or_incomplete_coverage" if flow_uncertain else
                      "insufficient_positive_daily_observations" if drawdown is None else
                      "complete_activity_walk_as_of_observation",
            "scope": "sampled_account_equity_not_intraday_maximum_or_strategy_performance",
            "risk": _session_return_metrics(values, dates, flow_uncertain)}


def summarize_forward_observations(*, activities, orders_by_id, equity_observations,
                                   window_start, window_end, activities_complete, mode="paper"):
    """Return JSON-safe observations over [start, end], never account identifiers.

    Quantities stay per symbol/side; notional and limit deltas use quoted price
    currency. Date-only non-trade rows crossing a boundary cannot be attributed
    to this intraday window. Missing orders do not erase actual FILL evidence.
    """
    require(mode == "paper" and type(activities_complete) is bool, "paper_coverage_required")
    require(isinstance(orders_by_id, dict), "orders_shape")
    start, end = stamp(window_start), stamp(window_end)
    require(start < end, "window_invalid")
    unique, duplicates = unique_activities(activities)
    rows, ambiguous, outside = [], 0, 0
    for row in unique:
        first, last = activity_interval(row)
        if last < start or first > end or (last != first and last == start):
            outside += 1
        elif first < start or last > end:
            ambiguous += 1
        else:
            rows.append(row)
    fees, external, unknown = [], [], 0
    for row in rows:
        kind = row["activity_type"]
        if kind in EXTERNAL:
            amount = number(row.get("net_amount"))
            require(amount != 0 and (kind != "CSD" or amount > 0)
                    and (kind != "CSW" or amount < 0), "cash_flow_sign_invalid")
            external.append(amount)
        elif kind in FEES:
            # CFEE can be denominated in crypto: never add it to USD charges.
            if kind == "CFEE" and row.get("currency") != "USD":
                unknown += 1
            else:
                fees.append(number(row.get("net_amount")))
        elif kind != "FILL" and kind not in INTERNAL:
            unknown += 1
    flow_uncertain = bool(external or unknown or ambiguous or not activities_complete)
    fills_summary = fill_metrics(rows, orders_by_id)
    equity_summary = equity_metrics(equity_observations, start, end, flow_uncertain)
    average_equity = equity_summary["average_observed_equity"]
    return {
        "schema_version": 1, "mode": "paper", "scope": "account_not_strategy_attributed",
        "window_start": start.isoformat(), "window_end": end.isoformat(),
        "coverage": {"activities_complete": activities_complete, "unique_activity_count": len(unique),
                     "duplicate_count": duplicates, "in_window_activity_count": len(rows),
                     "outside_window_count": outside, "boundary_ambiguous_count": ambiguous,
                     "unclassified_activity_count": unknown, "finality": "as_of_collection_not_settlement_final"},
        "fills": fills_summary,
        "turnover": _turnover_metrics(
            number(fills_summary["notional"]),
            number(average_equity) if average_equity is not None else None,
            flow_uncertain,
        ),
        "fees": {"observed_activity_count": len(fees),
                 "observed_net_debit": scalar(-sum(fees, Decimal(0))) if fees else None,
                 "final_total": None, "status": "OBSERVED_NOT_FINAL" if fees else "UNKNOWN",
                 "reason": "late_posting_possible_and_no_trade_attribution"},
        "external_cash_flows": {"observed_count": len(external),
                                "observed_net_amount": scalar(sum(external, Decimal(0)))},
        "equity": equity_summary,
    }
