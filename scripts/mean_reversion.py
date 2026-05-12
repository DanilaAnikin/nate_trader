"""Mean reversion overlay — capture oversold bounces in NEUTRAL/BEAR regimes.

The momentum engine has no edge in non-trending markets. Backtest shows
NEUTRAL = −11.97% and BEAR = +1.33% over 5 years. Mean reversion picks
up the bounce side of those choppy periods: when a name is washed out
(RSI < 30, price 8% below 20-SMA, capitulation volume), there's a
statistical edge to a 2-5 day bounce.

This module is a SEPARATE candidate source, complementary to the
momentum engine. MR trades have:
  • Different signals (oversold, not breakout)
  • Smaller sizes (2-3% per trade vs momentum's 6-10%)
  • Faster exits (RSI > 55 / +5% / −3% stop / 5d time stop)
  • Their own portfolio sleeve (~20-25% of equity)
  • Marked as `is_mr=True` so they don't compete with momentum slots

Activation: only when SPY regime in {NEUTRAL, BEAR}. In BULL we let
momentum do its job; trying MR in a strong uptrend usually catches
"falling knives" — temporary weakness in stocks that keep going down.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# Tunables — tightened after v3 backtest showed MR firing too loose and
# producing falling-knife trades. New defaults require deeper oversold
# (RSI<25), bigger volume spike (≥2.5× = real capitulation), and exclude
# names underperforming SPY by >3% over 20d (so we only buy names that
# *temporarily* sold off rather than chronic underperformers).
RSI_OVERSOLD = 25
PRICE_BELOW_SMA20_PCT = 10.0       # require price ≥ 10% below 20-SMA (was 8%)
VOLUME_CAPITULATION_RATIO = 2.5    # volume ≥ 2.5× 20d avg (was 1.5×)
RS_FLOOR = -3.0                    # only −3% vs SPY tolerable (was −15%)

# Exit triggers — slightly faster turns
RSI_EXIT = 50                      # close earlier on bounce (was 55)
GAIN_TARGET_PCT = 4.0              # take-profit sooner (was 5%)
LOSS_STOP_PCT = -2.5               # tighter stop (was −3%)
TIME_STOP_DAYS = 4                 # close 4 trading days regardless (was 5)

# Sleeve sizing — smaller cap so MR errors don't dominate
MR_SLEEVE_PCT = 15.0               # was 25%
MR_POSITION_PCT = 2.0              # was 3%

ACTIVE_REGIMES = {"NEUTRAL", "BEAR"}


@dataclass
class MRCandidate:
    symbol: str
    technicals: dict
    sector: Optional[str]
    score: float        # 0.0–1.0 strength of the MR setup
    reasons: list[str]  # human-readable details


# ───────────────────────── core signal logic ───────────────────────────────


def is_mr_setup(technicals: dict, spy_20d_return: float = 0.0,
                rs_floor: float = RS_FLOOR) -> tuple[bool, list[str]]:
    """Return (is_oversold_bounce_candidate, reasons).

    Pure function — no I/O, fully testable.
    """
    reasons = []

    rsi = technicals.get("rsi_14")
    if rsi is None or rsi >= RSI_OVERSOLD:
        return False, [f"RSI {rsi} not oversold (<{RSI_OVERSOLD})"]
    reasons.append(f"RSI {rsi:.1f} < {RSI_OVERSOLD}")

    price = technicals.get("price")
    sma_20 = technicals.get("sma_20")
    if price is None or sma_20 is None:
        return False, ["price/SMA20 missing"]
    pct_below = (1 - price / sma_20) * 100
    if pct_below < PRICE_BELOW_SMA20_PCT:
        return False, [f"only {pct_below:.1f}% below SMA20 (need ≥{PRICE_BELOW_SMA20_PCT}%)"]
    reasons.append(f"{pct_below:.1f}% below SMA20")

    vol_ratio = technicals.get("volume_ratio")
    if vol_ratio is None or vol_ratio < VOLUME_CAPITULATION_RATIO:
        return False, [f"volume_ratio {vol_ratio} not capitulation (≥{VOLUME_CAPITULATION_RATIO})"]
    reasons.append(f"volume {vol_ratio:.2f}× avg (capitulation)")

    # Filter out "falling knives" — names down too much vs SPY 20d
    stock_20d = technicals.get("twenty_day_return", 0.0)
    alpha_20d = stock_20d - spy_20d_return
    if alpha_20d < rs_floor:
        return False, [f"20d alpha {alpha_20d:+.1f}% < floor {rs_floor:+.1f}% (falling knife)"]
    reasons.append(f"20d alpha {alpha_20d:+.1f}% (not falling knife)")

    return True, reasons


def score_mr_setup(technicals: dict, spy_20d_return: float = 0.0) -> float:
    """Strength score 0.0-1.0 for an MR candidate that passed is_mr_setup.

    Higher = stronger oversold setup. Used to rank candidates when more
    than MR_SLEEVE_PCT worth of signals are present.
    """
    rsi = technicals.get("rsi_14", 50)
    price = technicals.get("price", 1)
    sma_20 = technicals.get("sma_20", 1)
    vol_ratio = technicals.get("volume_ratio", 1)

    # Lower RSI = stronger setup
    rsi_score = max(0, (RSI_OVERSOLD - rsi) / RSI_OVERSOLD)   # 0..1 (lower RSI → higher)
    # Further below SMA = stronger
    pct_below = max(0, (1 - price / sma_20) * 100)
    sma_score = min(1.0, pct_below / 20.0)                     # 0..1, caps at 20% below
    # Bigger volume spike = stronger
    vol_score = min(1.0, (vol_ratio - 1.0) / 3.0)              # 0..1, caps at 4× vol

    return 0.45 * rsi_score + 0.35 * sma_score + 0.20 * vol_score


def should_exit_mr(position_pnl_pct: float, current_rsi: float | None,
                   days_held: int) -> tuple[bool, str]:
    """Return (should_exit, reason) for an active MR position.

    Pure function.
    """
    if position_pnl_pct >= GAIN_TARGET_PCT:
        return True, f"MR_TARGET (+{position_pnl_pct:.2f}% ≥ +{GAIN_TARGET_PCT}%)"
    if position_pnl_pct <= LOSS_STOP_PCT:
        return True, f"MR_STOP ({position_pnl_pct:.2f}% ≤ {LOSS_STOP_PCT}%)"
    if current_rsi is not None and current_rsi >= RSI_EXIT:
        return True, f"MR_RSI_BOUNCE (RSI {current_rsi:.1f} ≥ {RSI_EXIT})"
    if days_held >= TIME_STOP_DAYS:
        return True, f"MR_TIME_STOP ({days_held}d ≥ {TIME_STOP_DAYS}d)"
    return False, ""


# ───────────────────────── candidate finder ────────────────────────────────


def is_active(regime: str | None) -> bool:
    """MR engine only runs in NEUTRAL or BEAR regimes."""
    return regime in ACTIVE_REGIMES


def find_candidates(symbol_technicals: dict[str, dict],
                    symbol_sectors: dict[str, str | None],
                    regime: str | None,
                    spy_20d_return: float = 0.0) -> list[MRCandidate]:
    """Return MR candidates ranked by setup strength, ready for execution.

    Pure function — caller injects technicals/sectors dicts.
    Returns empty list when regime is BULL.
    """
    if not is_active(regime):
        return []

    candidates: list[MRCandidate] = []
    for sym, tech in symbol_technicals.items():
        if not tech or "error" in tech:
            continue
        ok, reasons = is_mr_setup(tech, spy_20d_return=spy_20d_return)
        if not ok:
            continue
        score = score_mr_setup(tech, spy_20d_return=spy_20d_return)
        candidates.append(MRCandidate(
            symbol=sym,
            technicals=tech,
            sector=symbol_sectors.get(sym),
            score=score,
            reasons=reasons,
        ))
    candidates.sort(key=lambda c: c.score, reverse=True)
    return candidates


# ───────────────────────── sizing for MR sleeve ────────────────────────────


def mr_position_size(equity: float, entry_price: float,
                     mr_sleeve_committed: float) -> int:
    """Number of shares for a new MR position, respecting sleeve cap.

    equity: total portfolio equity
    entry_price: entry price for the symbol
    mr_sleeve_committed: dollar value already deployed in MR positions

    Caps:
      • Per-position: MR_POSITION_PCT of equity (default 3%)
      • Sleeve total: MR_SLEEVE_PCT of equity (default 25%)
    """
    per_pos_dollars = equity * (MR_POSITION_PCT / 100.0)
    sleeve_dollars = equity * (MR_SLEEVE_PCT / 100.0)
    remaining_sleeve = sleeve_dollars - mr_sleeve_committed

    if remaining_sleeve <= 0:
        return 0

    dollars = min(per_pos_dollars, remaining_sleeve)
    return max(0, int(dollars / entry_price))
