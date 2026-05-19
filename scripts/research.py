"""Research — market data, technical analysis, confidence scoring."""

import sys
from datetime import datetime, timedelta

import pandas as pd
import ta

from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import (
    StockBarsRequest,
    StockLatestQuoteRequest,
)
from alpaca.data.timeframe import TimeFrame
from alpaca.data.enums import DataFeed
from alpaca.trading.client import TradingClient
from alpaca.common.exceptions import APIError

from utils import (
    ALPACA_API_KEY, ALPACA_SECRET_KEY, RESEARCH_STATE,
    setup_logging, get_now_str, load_json, save_json,
    get_tradeable_symbols, get_all_symbols, get_symbol_info,
)

log = setup_logging("research")

data_client = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)
trading_client = TradingClient(ALPACA_API_KEY, ALPACA_SECRET_KEY, paper=True)


def get_bars(symbol: str, days: int = 80, timeframe: TimeFrame = TimeFrame.Day) -> pd.DataFrame:
    """Fetch historical bars for a symbol."""
    end = datetime.now()
    start = end - timedelta(days=days + 30)  # buffer for weekends/holidays
    request = StockBarsRequest(
        symbol_or_symbols=symbol,
        timeframe=timeframe,
        start=start,
        end=end,
        feed=DataFeed.IEX,
    )
    bars = data_client.get_stock_bars(request)
    df = bars.df
    if isinstance(df.index, pd.MultiIndex):
        df = df.droplevel("symbol")
    return df.tail(days)


def get_4h_technicals(symbol: str) -> dict:
    """Multi-timeframe overlay — compact 4-hour indicators for MTF scoring.

    Pulls ~33 days of 4-hour bars (≈ 200 bars at 6 trading-day bars / day),
    computes RSI(14), MACD signal cross, and price-vs-SMA20. Used by
    multi_timeframe.compute_mtf_adjustment to add a confirmation bonus to
    daily-bar scoring.

    Returns: dict with `rsi_14`, `macd_above_signal`, `price_above_sma20`
    (or None entries on failure / insufficient data).
    """
    from alpaca.data.timeframe import TimeFrame as _TF, TimeFrameUnit as _TFU
    import ta
    try:
        tf = _TF(amount=4, unit=_TFU.Hour)
        end = datetime.now()
        start = end - timedelta(days=45)  # ~33 trading days × 6 bars
        request = StockBarsRequest(
            symbol_or_symbols=symbol,
            timeframe=tf,
            start=start, end=end, feed=DataFeed.IEX,
        )
        bars = data_client.get_stock_bars(request)
        df = bars.df
        if isinstance(df.index, pd.MultiIndex):
            df = df.droplevel("symbol")
        if len(df) < 30:
            return {"rsi_14": None, "macd_above_signal": False, "price_above_sma20": False}
        close = df["close"].astype(float)
        rsi = ta.momentum.rsi(close, window=14).iloc[-1]
        sma20 = ta.trend.sma_indicator(close, window=20).iloc[-1]
        macd_line = ta.trend.macd(close, window_slow=26, window_fast=12).iloc[-1]
        macd_sig = ta.trend.macd_signal(close, window_slow=26, window_fast=12, window_sign=9).iloc[-1]
        price = float(close.iloc[-1])
        return {
            "rsi_14": float(rsi) if pd.notna(rsi) else None,
            "macd_above_signal": bool(pd.notna(macd_line) and pd.notna(macd_sig) and macd_line > macd_sig),
            "price_above_sma20": bool(pd.notna(sma20) and price > float(sma20)),
        }
    except Exception as e:
        log.warning(f"  {symbol}: 4h fetch failed — {e}")
        return {"rsi_14": None, "macd_above_signal": False, "price_above_sma20": False}


def get_latest_quote(symbol: str) -> dict:
    """Get latest quote for a symbol."""
    request = StockLatestQuoteRequest(symbol_or_symbols=symbol, feed=DataFeed.IEX)
    quotes = data_client.get_stock_latest_quote(request)
    q = quotes[symbol]
    return {
        "symbol": symbol,
        "bid": float(q.bid_price),
        "ask": float(q.ask_price),
        "bid_size": float(q.bid_size),
        "ask_size": float(q.ask_size),
        "mid": (float(q.bid_price) + float(q.ask_price)) / 2,
        "timestamp": str(q.timestamp),
    }


def get_news(symbol: str, limit: int = 10) -> list[dict]:
    """Get recent news for a symbol using Alpaca News API."""
    import requests
    url = "https://data.alpaca.markets/v1beta1/news"
    headers = {
        "APCA-API-KEY-ID": ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
    }
    params = {
        "symbols": symbol,
        "limit": limit,
        "sort": "desc",
    }
    resp = requests.get(url, headers=headers, params=params)
    resp.raise_for_status()
    news_data = resp.json().get("news", [])
    results = []
    for article in news_data:
        results.append({
            "headline": article.get("headline", ""),
            "summary": article.get("summary", ""),
            "source": article.get("source", ""),
            "created_at": article.get("created_at", ""),
            "url": article.get("url", ""),
            "symbols": article.get("symbols", []),
        })
    return results


def compute_technicals(df: pd.DataFrame) -> dict:
    """Compute technical indicators from bar data."""
    if len(df) < 20:
        return {"error": "Insufficient data"}

    close = df["close"].astype(float)
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    volume = df["volume"].astype(float)

    # SMAs
    sma_20 = ta.trend.sma_indicator(close, window=20)
    sma_50 = ta.trend.sma_indicator(close, window=50) if len(close) >= 50 else pd.Series([None] * len(close))

    # RSI
    rsi = ta.momentum.rsi(close, window=14)

    # MACD
    macd = ta.trend.macd(close, window_slow=26, window_fast=12)
    macd_signal = ta.trend.macd_signal(close, window_slow=26, window_fast=12, window_sign=9)

    # Bollinger Bands
    bb_high = ta.volatility.bollinger_hband(close, window=20, window_dev=2)
    bb_low = ta.volatility.bollinger_lband(close, window=20, window_dev=2)
    bb_mid = ta.volatility.bollinger_mavg(close, window=20)

    # Volume analysis — use previous completed day to avoid partial-day bias
    if len(volume) >= 2:
        prev_day_volume = float(volume.iloc[-2])
        vol_avg_20_completed = volume.iloc[:-1].rolling(window=20).mean()
        current_vol_avg = float(vol_avg_20_completed.iloc[-1]) if pd.notna(vol_avg_20_completed.iloc[-1]) else None
    else:
        prev_day_volume = float(volume.iloc[-1])
        current_vol_avg = float(volume.mean()) if len(volume) > 0 else None

    current_price = float(close.iloc[-1])
    current_volume = float(volume.iloc[-1])
    # Phase E (gap_scanner wiring): expose prior close + today's open so the
    # gap score can run on completed bars without a separate quote feed.
    prev_close = float(close.iloc[-2]) if len(close) >= 2 else None
    if "open" in df.columns and len(df) >= 1:
        today_open = float(df["open"].astype(float).iloc[-1])
    else:
        today_open = None
    current_sma20 = float(sma_20.iloc[-1]) if pd.notna(sma_20.iloc[-1]) else None
    current_sma50 = float(sma_50.iloc[-1]) if pd.notna(sma_50.iloc[-1]) else None
    current_rsi = float(rsi.iloc[-1]) if pd.notna(rsi.iloc[-1]) else None
    current_macd = float(macd.iloc[-1]) if pd.notna(macd.iloc[-1]) else None
    current_macd_signal = float(macd_signal.iloc[-1]) if pd.notna(macd_signal.iloc[-1]) else None
    current_bb_high = float(bb_high.iloc[-1]) if pd.notna(bb_high.iloc[-1]) else None
    current_bb_low = float(bb_low.iloc[-1]) if pd.notna(bb_low.iloc[-1]) else None
    current_bb_mid = float(bb_mid.iloc[-1]) if pd.notna(bb_mid.iloc[-1]) else None

    # 5-day return
    if len(close) >= 6:
        five_day_return = (current_price / float(close.iloc[-6]) - 1) * 100
    else:
        five_day_return = 0.0

    # 20-day return — used for relative strength vs SPY (less noisy than 5d)
    if len(close) >= 21:
        twenty_day_return = (current_price / float(close.iloc[-21]) - 1) * 100
    else:
        twenty_day_return = five_day_return

    # ATR(14) for volatility-aware stops / sizing
    if len(close) >= 15:
        atr_series = ta.volatility.average_true_range(high, low, close, window=14)
        current_atr = float(atr_series.iloc[-1]) if pd.notna(atr_series.iloc[-1]) else None
    else:
        current_atr = None

    # Annualized 20-day return-vol (% of price) — input to Phase-D vol-targeted
    # sizing. sqrt(252) is the trading-day annualization factor.
    if len(close) >= 21:
        daily_returns = close.pct_change().dropna()
        # Use the last 20 daily returns for a stable, short-horizon estimate
        recent = daily_returns.iloc[-20:]
        if len(recent) >= 5 and pd.notna(recent.std()):
            vol_20d_annualized_pct = float(recent.std() * (252 ** 0.5) * 100)
        else:
            vol_20d_annualized_pct = None
    else:
        vol_20d_annualized_pct = None

    # v3 — Donchian-style highs for breakout scoring. Uses the 20/50 days
    # BEFORE today, so "new high" means today actually broke out.
    high_series = high.astype(float)
    if len(high_series) >= 21:
        high_20d = float(high_series.iloc[-21:-1].max())
    else:
        high_20d = float(high_series.iloc[:-1].max()) if len(high_series) >= 2 else current_price
    if len(high_series) >= 51:
        high_50d = float(high_series.iloc[-51:-1].max())
    elif len(high_series) >= 2:
        high_50d = float(high_series.iloc[:-1].max())
    else:
        high_50d = current_price
    pct_from_20d_high = (current_price / high_20d - 1) * 100 if high_20d > 0 else 0.0
    pct_from_50d_high = (current_price / high_50d - 1) * 100 if high_50d > 0 else 0.0

    return {
        "price": current_price,
        "sma_20": current_sma20,
        "sma_50": current_sma50,
        "rsi_14": current_rsi,
        "macd": current_macd,
        "macd_signal": current_macd_signal,
        "bb_upper": current_bb_high,
        "bb_lower": current_bb_low,
        "bb_mid": current_bb_mid,
        "volume": current_volume,
        "vol_avg_20": current_vol_avg,
        "volume_ratio": prev_day_volume / current_vol_avg if current_vol_avg and current_vol_avg > 0 else None,
        "five_day_return": five_day_return,
        "twenty_day_return": twenty_day_return,
        "atr_14": current_atr,
        "atr_pct": (current_atr / current_price * 100) if current_atr and current_price else None,
        "vol_20d_annualized_pct": vol_20d_annualized_pct,
        "prev_close": prev_close,
        "today_open": today_open,
        "above_sma20": current_price > current_sma20 if current_sma20 else None,
        "above_sma50": current_price > current_sma50 if current_sma50 else None,
        # v3 momentum fields
        "high_20d": high_20d,
        "high_50d": high_50d,
        "pct_from_20d_high": pct_from_20d_high,
        "pct_from_50d_high": pct_from_50d_high,
        "new_20d_high": current_price >= high_20d,
        "new_50d_high": current_price >= high_50d,
    }


def score_news(news: list[dict]) -> int:
    """Simple news sentiment scoring (0-35)."""
    if not news:
        return 5  # no news

    positive_keywords = [
        "beat", "surge", "rally", "upgrade", "record", "growth", "profit",
        "revenue beat", "strong", "bullish", "outperform", "raise", "positive",
        "momentum", "breakout", "deal", "partnership", "launch", "innovation",
    ]
    negative_keywords = [
        "miss", "decline", "downgrade", "loss", "weak", "bearish", "underperform",
        "warning", "cut", "layoff", "negative", "crash", "sell-off", "concern",
        "risk", "lawsuit", "investigation", "recall",
    ]

    score = 5  # baseline
    for article in news[:5]:  # only check top 5
        headline = article.get("headline", "").lower()
        for kw in positive_keywords:
            if kw in headline:
                score += 4
                break
        for kw in negative_keywords:
            if kw in headline:
                score -= 4
                break

    return max(0, min(35, score))


def compute_confidence_score(
    technicals: dict,
    news_score: int,
    perplexity_score: int = 0,
    regime: str | None = None,
    risk_tier: str | None = None,
    spy_20d_return: float | None = None,
    sector: str | None = None,
    four_h: dict | None = None,
    sector_state: dict | None = None,
) -> dict:
    """Compute composite confidence score (0-100), regime-aware.

    Rebalanced scoring — three components:

      Technical Score (max 50):
        • Trend (SMA stack)           : up to 12
        • RSI in regime sweet spot    : up to 10
        • MACD bullish                : up to 10 (7 crossover + 3 above zero)
        • Volume confirmation         : up to 5
        • ATR squeeze (low vol entry) : up to 5
        • Bollinger position          : up to 3
        • 20-day momentum             : up to 5

      Catalyst Score (max 25):
        • News (rescaled 0-35 → 0-12) + Perplexity (rescaled 0-30 → 0-13)

      Momentum Alpha Score (max 25):
        • Pure relative strength vs SPY 20-day return
    """
    from strategy_config import get_strategy_params

    params = get_strategy_params(regime, risk_tier)
    tech_score = 0

    # 1) Trend alignment (max 12)
    above_20 = technicals.get("above_sma20")
    above_50 = technicals.get("above_sma50")
    if above_20 and above_50:
        tech_score += 12
    elif above_20:
        tech_score += 6
    elif above_50:
        tech_score += 3

    # 2) RSI sweet spot (max 10) — regime adaptive
    rsi = technicals.get("rsi_14")
    if rsi is not None:
        sweet_lo = params["rsi_sweet_low"]
        sweet_hi = params["rsi_sweet_high"]
        accept_lo = params["rsi_acceptable_low"]
        accept_hi = params["rsi_acceptable_high"]
        if sweet_lo <= rsi <= sweet_hi:
            tech_score += 10
        elif accept_lo <= rsi <= accept_hi:
            tech_score += 5

    # 3) MACD bullish crossover (max 10: 7 crossover + 3 above zero)
    macd = technicals.get("macd")
    macd_sig = technicals.get("macd_signal")
    if macd is not None and macd_sig is not None:
        if macd > macd_sig:
            tech_score += 7
            if macd > 0:
                tech_score += 3

    # 4) Volume confirmation (max 5) — regime-adaptive gate
    vol_ratio = technicals.get("volume_ratio")
    if vol_ratio is not None:
        if vol_ratio >= params["volume_min_ratio"] * 1.25:
            tech_score += 5
        elif vol_ratio >= params["volume_min_ratio"]:
            tech_score += 3

    # 5) 20-day high breakout (max 4) — v3 momentum signal
    pct_from_20d = technicals.get("pct_from_20d_high")
    if pct_from_20d is not None:
        if pct_from_20d >= -2.0:     # within 2% of (or above) 20-day high
            tech_score += 4
        elif pct_from_20d >= -5.0:   # within 5%
            tech_score += 2

    # 6) 50-day high breakout (max 6) — v3 new structural high
    pct_from_50d = technicals.get("pct_from_50d_high")
    new_50d = technicals.get("new_50d_high")
    if pct_from_50d is not None:
        if new_50d or pct_from_50d >= 0.0:
            tech_score += 6
        elif pct_from_50d >= -3.0:
            tech_score += 3

    # v3 removed: ATR squeeze (+5), Bollinger lower-band (+3) — mean-rev noise
    # conflicted with momentum thesis. The 10 points reallocated to breakout.

    # 7) 20-day momentum (max 5)
    twenty_d = technicals.get("twenty_day_return")
    if twenty_d is not None:
        if twenty_d >= 10:
            tech_score += 5
        elif twenty_d >= 5:
            tech_score += 3
        elif twenty_d >= 0:
            tech_score += 1

    # Cap technical score at 50
    tech_score = min(50, tech_score)

    # ── Catalyst Score (max 25) — rescaled news + perplexity ──
    rescaled_news = min(12, round(news_score * 12 / 35))
    rescaled_px = min(13, round(perplexity_score * 13 / 30)) if perplexity_score else 0
    catalyst_score = min(25, rescaled_news + rescaled_px)

    # ── Momentum Alpha Score (max 25) — sector-relative RS, fallback to SPY ──
    # Phase C of ALPHA_PLAN.md: prefer sector-relative RS over SPY-relative.
    # Within a leading sector we want the leader; within a lagging sector we
    # want to skip even names that are beating SPY because they're getting
    # lifted by the broader move rather than earning real selection alpha.
    # Sector return is sourced from sector_state["sector_returns"][sector],
    # which is produced by the pre-market routine (live) or per-day
    # historical state (backtest, look-ahead-safe).
    alpha_score = 0
    stock_20d = technicals.get("twenty_day_return")
    sector_20d = None
    if sector and sector_state:
        sector_returns = sector_state.get("sector_returns") or {}
        sector_20d = sector_returns.get(sector)
    rs_benchmark = sector_20d if sector_20d is not None else spy_20d_return
    if stock_20d is not None and rs_benchmark is not None:
        alpha = stock_20d - rs_benchmark
        if alpha >= 15:
            alpha_score = 25
        elif alpha >= 10:
            alpha_score = 20
        elif alpha >= 5:
            alpha_score = 15
        elif alpha >= 2:
            alpha_score = 10
        elif alpha >= 0:
            alpha_score = 5
    elif stock_20d is not None:
        # No benchmark data — use absolute momentum as fallback
        if stock_20d >= 15:
            alpha_score = 20
        elif stock_20d >= 10:
            alpha_score = 15
        elif stock_20d >= 5:
            alpha_score = 10
        elif stock_20d >= 0:
            alpha_score = 5

    # ── Sector rotation adjustment (±5) ──
    # Top-3 sectors by 20d alpha get +5, bottom-3 get −5.
    # Live: reads state/sector_strength.json (refreshed daily pre-market).
    # Backtest: receives a per-day historical state dict from engine to
    # avoid the look-ahead bias of using today's snapshot for past days.
    sector_adj = 0
    if sector:
        try:
            from ablation_flags import ABLATE_SECTOR_ROT
            from sector_rotation import compute_sector_adjustment
            if not ABLATE_SECTOR_ROT:
                sector_adj = compute_sector_adjustment(sector, state=sector_state)
        except Exception:
            sector_adj = 0

    # ── Multi-timeframe adjustment (−5 to +8) ──
    # 4h bar confirmation of daily signals. Strong agreement bonuses,
    # divergence penalty. Missing 4h data → 0 (graceful degrade).
    mtf_adj = 0
    if four_h is not None:
        try:
            from ablation_flags import ABLATE_MULTI_TF
            if ABLATE_MULTI_TF:
                raise RuntimeError("ablated")
            from multi_timeframe import compute_mtf_adjustment, TimeframeTechnicals
            daily_tf = TimeframeTechnicals(
                rsi_14=technicals.get("rsi_14"),
                macd_above_signal=(
                    technicals.get("macd") is not None
                    and technicals.get("macd_signal") is not None
                    and technicals["macd"] > technicals["macd_signal"]
                ),
                price_above_sma20=bool(technicals.get("above_sma20")),
            )
            four_h_tf = TimeframeTechnicals(
                rsi_14=four_h.get("rsi_14"),
                macd_above_signal=four_h.get("macd_above_signal", False),
                price_above_sma20=four_h.get("price_above_sma20", False),
            )
            mtf_adj = compute_mtf_adjustment(daily_tf, four_h_tf, regime=regime)
        except Exception:
            mtf_adj = 0

    # ── ML aggregator adjustment (−5 to +5) ──
    # Random-forest classifier trained on engineered features (RSI, MACD,
    # returns, regime, etc) predicts forward 5-day return > +2%. The
    # probability is mapped to ±5 score points. Silently returns 0 if
    # no model trained yet (graceful degrade).
    ml_adj = 0
    try:
        from ablation_flags import ABLATE_ML
        if ABLATE_ML:
            raise RuntimeError("ablated")
        from ml_signals import extract_features as _ml_features, predict_proba, ml_score_from_proba
        # We don't have the bars df here — caller can pre-compute features
        # and pass via technicals.get("_ml_features"). Otherwise we skip.
        ml_features = technicals.get("_ml_features")
        if ml_features:
            proba = predict_proba(ml_features)
            ml_adj = ml_score_from_proba(proba)
    except Exception:
        ml_adj = 0

    # ── Retail sentiment adjustment (−3 to +3) ──
    sent_adj = 0
    try:
        from ablation_flags import ABLATE_SENTIMENT
        if ABLATE_SENTIMENT:
            raise RuntimeError("ablated")
        from sentiment import get_sentiment_score, sentiment_to_adjustment
        # Use technicals._symbol shortcut, or skip if absent
        sym = technicals.get("_symbol")
        if sym:
            sent_adj = sentiment_to_adjustment(get_sentiment_score(sym))
    except Exception:
        sent_adj = 0

    # ── Gap-scanner adjustment (0 to +5) ──
    # Phase E of ALPHA_PLAN.md: catches overnight gap-ups with volume
    # confirmation as a momentum-continuation bonus. Uses last 2 completed
    # bars so it works in both live and backtest without a pre-market feed.
    gap_adj = 0
    try:
        from gap_scanner import score_gap_from_technicals
        gap_adj = score_gap_from_technicals(technicals)
    except Exception:
        gap_adj = 0

    total = (tech_score + catalyst_score + alpha_score
             + sector_adj + mtf_adj + ml_adj + sent_adj + gap_adj)

    threshold = params["score_threshold"]
    # Action bands scale with regime (lower thresholds = wider HOLD band)
    sell_threshold = max(25, threshold - 15)
    if total >= threshold:
        action = "BUY"
    elif total >= sell_threshold:
        action = "HOLD"
    else:
        action = "SELL"

    return {
        "technical_score": tech_score,
        "news_score": news_score,
        "perplexity_score": perplexity_score,
        "catalyst_score": catalyst_score,
        "alpha_score": alpha_score,
        "sector_adj": sector_adj,
        "mtf_adj": mtf_adj,
        "ml_adj": ml_adj,
        "sent_adj": sent_adj,
        "gap_adj": gap_adj,
        "total": total,
        "action": action,
        "threshold_used": threshold,
        "regime": regime or "auto",
    }


def get_spy_benchmark() -> dict:
    """Get SPY benchmark data for comparison."""
    df = get_bars("SPY", days=220)  # v3: enough for 200-SMA
    technicals = compute_technicals(df)

    # Monthly return (approx 22 trading days)
    close = df["close"].astype(float)
    if len(close) >= 22:
        month_return = (float(close.iloc[-1]) / float(close.iloc[-22]) - 1) * 100
    else:
        month_return = (float(close.iloc[-1]) / float(close.iloc[0]) - 1) * 100

    # 20-day return — used for stock relative-strength comparison
    if len(close) >= 21:
        twenty_day_return = (float(close.iloc[-1]) / float(close.iloc[-21]) - 1) * 100
    else:
        twenty_day_return = month_return

    # 200-day SMA — v3 hedge gate uses this
    if len(close) >= 200:
        sma_200 = float(close.rolling(window=200).mean().iloc[-1])
    else:
        sma_200 = None

    # Market regime
    price = technicals.get("price", 0)
    sma20 = technicals.get("sma_20")
    sma50 = technicals.get("sma_50")
    if sma20 and sma50:
        if price > sma20 > sma50:
            regime = "BULL"
        elif price < sma20 and sma20 < sma50:
            regime = "BEAR"
        else:
            regime = "NEUTRAL"
    else:
        regime = "UNKNOWN"

    return {
        "symbol": "SPY",
        "price": technicals.get("price"),
        "sma_20": sma20,
        "sma_50": sma50,
        "sma_200": sma_200,
        "below_sma_200": (price < sma_200) if (price and sma_200) else None,
        "rsi_14": technicals.get("rsi_14"),
        "five_day_return": technicals.get("five_day_return"),
        "twenty_day_return": twenty_day_return,
        "monthly_return": month_return,
        "market_regime": regime,
        "updated_at": get_now_str(),
    }


def research_symbol(symbol: str, regime: str | None = None) -> dict:
    """Research any single symbol on demand. Returns full analysis dict."""
    log.info(f"Researching {symbol}...")
    try:
        df = get_bars(symbol, days=60)
        technicals = compute_technicals(df)
        if "error" in technicals:
            return {"symbol": symbol, "error": technicals["error"]}

        try:
            news = get_news(symbol, limit=5)
            n_score = score_news(news)
            news_headlines = [a["headline"] for a in news[:3]]
        except Exception as e:
            log.warning(f"News fetch failed for {symbol}: {e}")
            news = []
            n_score = 5
            news_headlines = []

        # If regime not provided, read from research state (may be stale; that's OK)
        existing = load_json(RESEARCH_STATE)
        if regime is None:
            regime = existing.get("spy", {}).get("market_regime")
        spy_20d = existing.get("spy", {}).get("twenty_day_return", 0.0)

        sym_info = get_symbol_info(symbol)
        confidence = compute_confidence_score(
            technicals, n_score, regime=regime,
            spy_20d_return=spy_20d, sector=sym_info.get("sector"),
        )

        result = {
            "symbol": symbol,
            "technicals": technicals,
            "news_score": n_score,
            "news_headlines": news_headlines,
            "confidence": confidence,
            "info": sym_info,
            "updated_at": get_now_str(),
        }
        log.info(f"  {symbol}: ${technicals['price']:.2f} | Score: {confidence['total']} ({confidence['action']})")
        return result

    except Exception as e:
        log.error(f"Error researching {symbol}: {e}")
        return {"symbol": symbol, "error": str(e)}


def build_research_report() -> dict:
    """Build full research report for all watchlist symbols."""
    log.info("Building research report...")
    existing_research = load_json(RESEARCH_STATE)
    report = {"updated_at": get_now_str(), "spy": {}, "symbols": {}}

    # SPY benchmark — gates regime for downstream scoring
    regime = "NEUTRAL"
    spy_20d = 0.0
    try:
        spy = get_spy_benchmark()
        report["spy"] = spy
        regime = spy.get("market_regime", "NEUTRAL")
        spy_20d = spy.get("twenty_day_return", 0.0)
        log.info(f"SPY: ${spy['price']:.2f} | Regime: {regime} | Month: {spy['monthly_return']:+.2f}%")
    except Exception as e:
        log.error(f"SPY benchmark error: {e}")

    # Research each tradeable symbol
    symbols = get_tradeable_symbols()
    for symbol in symbols:
        try:
            log.info(f"Researching {symbol}...")
            df = get_bars(symbol, days=60)
            technicals = compute_technicals(df)

            # Get news and score
            try:
                news = get_news(symbol, limit=5)
                n_score = score_news(news)
                news_headlines = [a["headline"] for a in news[:3]]
            except Exception as e:
                log.warning(f"News fetch failed for {symbol}: {e}")
                news = []
                n_score = 5
                news_headlines = []

            # Carry over existing Perplexity data if available and fresh (< 3 days)
            existing_sym = existing_research.get("symbols", {}).get(symbol, {})
            existing_perplexity = existing_sym.get("perplexity", {})
            existing_px_score = existing_perplexity.get("perplexity_score", 0)

            # Check staleness — drop Perplexity data older than 3 days
            if existing_px_score > 0:
                px_updated = existing_perplexity.get("updated_at", "")
                if px_updated:
                    try:
                        px_age = datetime.now() - datetime.strptime(px_updated, "%Y-%m-%d %H:%M:%S")
                        if px_age.days >= 3:
                            log.info(f"  {symbol}: Perplexity data stale ({px_age.days}d old) — dropping")
                            existing_px_score = 0
                            existing_perplexity = {}
                    except ValueError:
                        pass  # can't parse date, keep it

            # Confidence score — regime-aware, include preserved Perplexity score
            sym_info_for_score = get_symbol_info(symbol)

            # 4h MTF data — optional, fetch best-effort (skipped on failure)
            try:
                four_h_data = get_4h_technicals(symbol)
            except Exception:
                four_h_data = None

            confidence = compute_confidence_score(
                technicals, n_score, existing_px_score, regime=regime,
                spy_20d_return=spy_20d, sector=sym_info_for_score.get("sector"),
                four_h=four_h_data,
            )

            sym_data = {
                "technicals": technicals,
                "news_score": n_score,
                "news_headlines": news_headlines,
                "confidence": confidence,
                "info": sym_info_for_score,
            }

            # Preserve fresh Perplexity data from previous runs
            if existing_px_score > 0:
                sym_data["perplexity"] = existing_perplexity
                log.info(f"  {symbol}: preserved Perplexity score {existing_px_score}/30")

            report["symbols"][symbol] = sym_data
            log.info(f"  {symbol}: ${technicals['price']:.2f} | Score: {confidence['total']} ({confidence['action']})")

        except Exception as e:
            log.error(f"Error researching {symbol}: {e}")
            report["symbols"][symbol] = {"error": str(e)}

    # Carry over perplexity_enhanced_at timestamp from previous run
    if existing_research.get("perplexity_enhanced_at"):
        report["perplexity_enhanced_at"] = existing_research["perplexity_enhanced_at"]

    # Save to state
    save_json(RESEARCH_STATE, report)
    log.info(f"Research report saved to {RESEARCH_STATE}")

    return report


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"

    if cmd == "report":
        report = build_research_report()
        print(f"\nResearch complete. {len(report.get('symbols', {}))} symbols analyzed.")
        for sym, data in report.get("symbols", {}).items():
            if "error" in data:
                print(f"  {sym}: ERROR - {data['error']}")
            else:
                c = data["confidence"]
                t = data["technicals"]
                print(f"  {sym}: ${t['price']:.2f} | Score: {c['total']} ({c['action']}) | RSI: {t.get('rsi_14', 0):.1f}")

    elif cmd == "symbol" and len(sys.argv) > 2:
        symbol = sys.argv[2].upper()
        result = research_symbol(symbol)
        if "error" in result:
            print(f"\n{symbol}: ERROR - {result['error']}")
        else:
            c = result["confidence"]
            t = result["technicals"]
            print(f"\n{symbol} Research:")
            print(f"  Price:   ${t['price']:.2f}")
            print(f"  SMA20:   ${t['sma_20']:.2f}" if t.get('sma_20') else "  SMA20:   N/A")
            print(f"  SMA50:   ${t['sma_50']:.2f}" if t.get('sma_50') else "  SMA50:   N/A")
            print(f"  RSI:     {t.get('rsi_14', 0):.1f}")
            print(f"  VolRatio:{t.get('volume_ratio', 0):.2f}")
            print(f"  5d Ret:  {t.get('five_day_return', 0):+.2f}%")
            print(f"  Score:   {c['total']} ({c['action']})")
            print(f"    Tech:  {c['technical_score']}/50")
            print(f"    Catalyst: {c.get('catalyst_score', 'n/a')}/25")
            print(f"    Alpha: {c.get('alpha_score', 'n/a')}/25")

    elif cmd == "quote" and len(sys.argv) > 2:
        symbol = sys.argv[2].upper()
        quote = get_latest_quote(symbol)
        print(f"\n{symbol} Quote:")
        print(f"  Bid: ${quote['bid']:.2f} ({quote['bid_size']})")
        print(f"  Ask: ${quote['ask']:.2f} ({quote['ask_size']})")
        print(f"  Mid: ${quote['mid']:.2f}")

    elif cmd == "spy":
        spy = get_spy_benchmark()
        print(f"\nSPY Benchmark:")
        print(f"  Price:    ${spy['price']:.2f}")
        print(f"  20-SMA:  ${spy['sma_20']:.2f}" if spy['sma_20'] else "  20-SMA:  N/A")
        print(f"  50-SMA:  ${spy['sma_50']:.2f}" if spy['sma_50'] else "  50-SMA:  N/A")
        print(f"  RSI:     {spy['rsi_14']:.1f}" if spy['rsi_14'] else "  RSI:     N/A")
        print(f"  5d Ret:  {spy['five_day_return']:+.2f}%")
        print(f"  Mo Ret:  {spy['monthly_return']:+.2f}%")
        print(f"  Regime:  {spy['market_regime']}")

    elif cmd == "news" and len(sys.argv) > 2:
        symbol = sys.argv[2].upper()
        news = get_news(symbol)
        print(f"\n{symbol} News ({len(news)} articles):")
        for article in news:
            print(f"  [{article['source']}] {article['headline']}")
            print(f"    {article['created_at']}")

    else:
        print("Usage: python3 research.py [report|symbol SYMBOL|quote SYMBOL|spy|news SYMBOL]")
