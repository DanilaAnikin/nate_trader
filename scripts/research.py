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


def compute_confidence_score(technicals: dict, news_score: int, perplexity_score: int = 0) -> dict:
    """Compute composite confidence score (0-100)."""
    tech_score = 0

    # Price > 20-SMA and 50-SMA (10 pts)
    if technicals.get("above_sma20") and technicals.get("above_sma50"):
        tech_score += 10
    elif technicals.get("above_sma20"):
        tech_score += 5

    # RSI 40-65 sweet spot (8 pts)
    rsi = technicals.get("rsi_14")
    if rsi and 40 <= rsi <= 65:
        tech_score += 8
    elif rsi and (30 <= rsi < 40 or 65 < rsi <= 70):
        tech_score += 4

    # MACD > signal (7 pts)
    macd = technicals.get("macd")
    macd_sig = technicals.get("macd_signal")
    if macd is not None and macd_sig is not None and macd > macd_sig:
        tech_score += 7

    # Price in lower half of Bollinger Bands (5 pts)
    price = technicals.get("price")
    bb_mid = technicals.get("bb_mid")
    bb_low = technicals.get("bb_lower")
    if price and bb_mid and bb_low and price <= bb_mid:
        tech_score += 5

    # Volume >= 1.2x avg (5 pts)
    vol_ratio = technicals.get("volume_ratio")
    if vol_ratio and vol_ratio >= 1.2:
        tech_score += 5

    total = tech_score + news_score + perplexity_score

    if total >= 65:
        action = "BUY"
    elif total >= 40:
        action = "HOLD"
    else:
        action = "SELL"

    return {
        "technical_score": tech_score,
        "news_score": news_score,
        "perplexity_score": perplexity_score,
        "total": total,
        "action": action,
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
        "monthly_return": month_return,
        "market_regime": regime,
        "updated_at": get_now_str(),
    }


def research_symbol(symbol: str) -> dict:
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

        confidence = compute_confidence_score(technicals, n_score)

        result = {
            "symbol": symbol,
            "technicals": technicals,
            "news_score": n_score,
            "news_headlines": news_headlines,
            "confidence": confidence,
            "info": get_symbol_info(symbol),
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

    # SPY benchmark
    try:
        spy = get_spy_benchmark()
        report["spy"] = spy
        log.info(f"SPY: ${spy['price']:.2f} | Regime: {spy['market_regime']} | Month: {spy['monthly_return']:+.2f}%")
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

            # Carry over existing Perplexity data if available
            existing_sym = existing_research.get("symbols", {}).get(symbol, {})
            existing_perplexity = existing_sym.get("perplexity", {})
            existing_px_score = existing_perplexity.get("perplexity_score", 0)

            # Confidence score — include preserved Perplexity score if available
            confidence = compute_confidence_score(technicals, n_score, existing_px_score)

            sym_data = {
                "technicals": technicals,
                "news_score": n_score,
                "news_headlines": news_headlines,
                "confidence": confidence,
                "info": get_symbol_info(symbol),
            }

            # Preserve Perplexity data from previous runs
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
            print(f"    Tech:  {c['technical_score']}/35")
            print(f"    News:  {c['news_score']}/35")

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
