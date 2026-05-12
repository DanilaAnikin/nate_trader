"""Phase 4 (scaffold) — Options-based asymmetric downside hedge.

Live SH ETF hedging gives 1:1 inverse exposure but eats opportunity cost
even in mild pullbacks. Options give convex (non-linear) protection:
small premium, large payoff in tail events.

Design (see IMPLEMENTATION_PLAN.md §3 phase 4):
  BEAR regime + not HALT:
    Maintain 1.5% equity in SPY puts, 30 DTE, 5% OTM.
    Roll at DTE ≤ 14. Close when regime returns to BULL.
  HALT tier:
    Step up to 3% in ATM puts, 45 DTE.

Risk caps:
  • Total premium at risk ≤ 5% equity any time
  • Skip if IV percentile > 90 (too expensive — better to widen SH)
  • Skip if SPY ≤ −15% YTD (puts already priced for the move)

Implementation status: NOT YET WIRED INTO LIVE EXECUTION.
This module exposes a pure decision function `decide_action()` that
the live engine can call once Alpaca options is enabled. Live wiring
will happen after Phase 3 (mean reversion) is validated in backtest.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional


Action = Literal["BUY_PUT", "ROLL_PUT", "CLOSE_PUT", "HOLD", "SKIP"]


@dataclass
class OptionPosition:
    """Snapshot of an existing SPY put position (or None)."""
    strike: float
    expiry_dte: int
    contracts: int
    premium_paid_pct_equity: float


@dataclass
class HedgeDecision:
    action: Action
    target_dte: int = 0
    target_otm_pct: float = 0.0
    target_premium_pct_equity: float = 0.0
    reason: str = ""


def decide_action(regime: str | None, risk_tier: str | None,
                  current_put: OptionPosition | None,
                  iv_percentile: float | None,
                  spy_ytd_return_pct: float | None,
                  total_options_premium_pct: float = 0.0) -> HedgeDecision:
    """Pure decision logic — given current state, what should the engine do?

    No I/O — all inputs are injected so this is fully testable.
    """
    # Hard skip conditions
    if total_options_premium_pct >= 5.0:
        return HedgeDecision(action="SKIP", reason="Total options premium ≥5% equity — cap reached")
    if iv_percentile is not None and iv_percentile > 90:
        return HedgeDecision(action="SKIP", reason=f"IV percentile {iv_percentile:.0f} > 90 — puts too rich")
    if spy_ytd_return_pct is not None and spy_ytd_return_pct <= -15:
        return HedgeDecision(action="SKIP", reason=f"SPY YTD {spy_ytd_return_pct:.1f}% — disaster already priced in")

    # Regime-driven targets
    if regime == "BULL" and risk_tier != "HALT":
        if current_put is not None:
            return HedgeDecision(action="CLOSE_PUT", reason="BULL regime — close hedge")
        return HedgeDecision(action="HOLD", reason="BULL — no hedge needed")

    # HALT overrides: max protection regardless of regime
    if risk_tier == "HALT":
        target_premium = 3.0
        target_dte = 45
        target_otm = 0.0  # ATM
    elif regime == "BEAR":
        target_premium = 1.5
        target_dte = 30
        target_otm = 5.0
    else:  # NEUTRAL — no options hedge (SH already handles)
        if current_put is not None:
            return HedgeDecision(action="CLOSE_PUT", reason="NEUTRAL — no options hedge (SH suffices)")
        return HedgeDecision(action="HOLD", reason="NEUTRAL — SH hedge active, no options")

    # Have a put? Check roll
    if current_put is not None:
        if current_put.expiry_dte <= 14:
            return HedgeDecision(
                action="ROLL_PUT",
                target_dte=target_dte, target_otm_pct=target_otm,
                target_premium_pct_equity=target_premium,
                reason=f"DTE {current_put.expiry_dte} ≤ 14 — roll out",
            )
        return HedgeDecision(action="HOLD", reason=f"Put OK (DTE {current_put.expiry_dte})")

    # No put — open new
    return HedgeDecision(
        action="BUY_PUT",
        target_dte=target_dte, target_otm_pct=target_otm,
        target_premium_pct_equity=target_premium,
        reason=f"{regime}/{risk_tier} — open new hedge",
    )


# NOTE: live execution (Alpaca options API calls) is intentionally NOT
# implemented yet. See IMPLEMENTATION_PLAN.md phase 4 acceptance criteria
# before wiring.
