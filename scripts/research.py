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
        "above_sma20": current_price > current_sma20 if current_sma20 else None,
        "above_sma50": current_price > current_sma50 if current_sma50 else None,
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

    # 5) ATR squeeze — low volatility entry signal (max 5)
    atr_pct = technicals.get("atr_pct")
    if atr_pct is not None:
        if atr_pct < 1.5:
            tech_score += 5   # very tight — coiled spring
        elif atr_pct < 2.5:
            tech_score += 3   # moderate squeeze

    # 6) Bollinger position — near lower band = entry (max 3)
    price = technicals.get("price")
    bb_lower = technicals.get("bb_lower")
    bb_upper = technicals.get("bb_upper")
    if price and bb_lower and bb_upper and bb_upper > bb_lower:
        bb_position = (price - bb_lower) / (bb_upper - bb_lower)
        if bb_position < 0.3:
            tech_score += 3   # near lower band
        elif bb_position < 0.5:
            tech_score += 1   # lower half

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

    # ── Momentum Alpha Score (max 25) — relative strength vs SPY ──
    alpha_score = 0
    stock_20d = technicals.get("twenty_day_return")
    if stock_20d is not None and spy_20d_return is not None:
        alpha = stock_20d - spy_20d_return
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
        # No SPY data — use absolute momentum as fallback
        if stock_20d >= 15:
            alpha_score = 20
        elif stock_20d >= 10:
            alpha_score = 15
        elif stock_20d >= 5:
            alpha_score = 10
        elif stock_20d >= 0:
            alpha_score = 5

    # ── Sector rotation adjustment (±5) ──
    # Top-3 sectors by 20d alpha get +5, bottom-3 get −5. Read from
    # state/sector_strength.json (refreshed daily). Missing data → 0.
    sector_adj = 0
    if sector:
        try:
            from sector_rotation import compute_sector_adjustment
            sector_adj = compute_sector_adjustment(sector)
        except Exception:
            sector_adj = 0

    total = tech_score + catalyst_score + alpha_score + sector_adj

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
        "total": total,
        "action": action,
        "threshold_used": threshold,
        "regime": regime or "auto",
    }


def get_spy_benchmark() -> dict:
    """Get SPY benchmark data for comparison."""
    df = get_bars("SPY", days=80)
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
            confidence = compute_confidence_score(
                technicals, n_score, existing_px_score, regime=regime,
                spy_20d_return=spy_20d, sector=sym_info_for_score.get("sector"),
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
