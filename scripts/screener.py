"""Stock screener — discover trading candidates beyond the watchlist."""

import sys
import requests

from utils import (
    ALPACA_API_KEY, ALPACA_SECRET_KEY, SCREENER_STATE,
    setup_logging, get_now_str, load_json, save_json,
    get_tradeable_symbols,
)

log = setup_logging("screener")

ALPACA_DATA_URL = "https://data.alpaca.markets"
ALPACA_PAPER_URL = "https://paper-api.alpaca.markets"

HEADERS = {
    "APCA-API-KEY-ID": ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
}


def get_most_active(limit: int = 20) -> list[dict]:
    """Get most active stocks by volume from Alpaca."""
    url = f"{ALPACA_DATA_URL}/v1beta1/screener/stocks/most-actives"
    params = {"by": "volume", "top": limit}
    try:
        resp = requests.get(url, headers=HEADERS, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        results = []
        for item in data.get("most_actives", []):
            results.append({
                "symbol": item.get("symbol", ""),
                "volume": item.get("volume", 0),
                "trade_count": item.get("trade_count", 0),
            })
        log.info(f"Most active: {len(results)} stocks fetched")
        return results
    except Exception as e:
        log.error(f"Most active fetch failed: {e}")
        return []


def get_top_movers(market_type: str = "stocks", limit: int = 20) -> list[dict]:
    """Get top movers (gainers) from Alpaca."""
    url = f"{ALPACA_DATA_URL}/v1beta1/screener/{market_type}/movers"
    params = {"top": limit}
    try:
        resp = requests.get(url, headers=HEADERS, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        results = []
        for item in data.get("gainers", []):
            results.append({
                "symbol": item.get("symbol", ""),
                "change_pct": item.get("percent_change", 0),
                "price": item.get("price", 0),
                "change": item.get("change", 0),
            })
        for item in data.get("losers", []):
            results.append({
                "symbol": item.get("symbol", ""),
                "change_pct": item.get("percent_change", 0),
                "price": item.get("price", 0),
                "change": item.get("change", 0),
            })
        log.info(f"Top movers: {len(results)} stocks fetched")
        return results
    except Exception as e:
        log.error(f"Top movers fetch failed: {e}")
        return []


def query_trending_from_perplexity() -> list[str]:
    """Ask Perplexity for trending stock tickers today."""
    from utils import PERPLEXITY_API_KEY

    if not PERPLEXITY_API_KEY:
        log.warning("No Perplexity API key — skipping trending query")
        return []

    prompt = """List the top 10 trending US stock tickers today based on news, social media,
and market activity. Only include stocks listed on NYSE or NASDAQ with market cap > $5B.

Return ONLY a JSON array of ticker symbols, e.g. ["AAPL", "NVDA", "TSLA"]. No other text."""

    try:
        headers = {
            "Authorization": f"Bearer {PERPLEXITY_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "sonar",
            "messages": [
                {"role": "system", "content": "You are a financial data assistant. Return only valid JSON."},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": 256,
            "temperature": 0.1,
        }
        resp = requests.post(
            "https://api.perplexity.ai/chat/completions",
            headers=headers, json=payload, timeout=30,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"].strip()

        # Parse JSON from response
        import json
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0].strip()
        elif "```" in content:
            content = content.split("```")[1].split("```")[0].strip()

        tickers = json.loads(content)
        if isinstance(tickers, list):
            result = [t.upper() for t in tickers if isinstance(t, str)]
            log.info(f"Trending from Perplexity: {result}")
            return result
    except Exception as e:
        log.error(f"Perplexity trending query failed: {e}")

    return []


def run_full_screen() -> dict:
    """Run full screener: combine all sources, score top candidates."""
    from research import get_bars, compute_technicals, get_news, score_news, compute_confidence_score

    log.info("Running full stock screen...")

    # Gather candidates from all sources
    most_active = get_most_active(limit=20)
    top_movers = get_top_movers(limit=20)
    trending = query_trending_from_perplexity()

    # Dedupe: collect all unique symbols
    all_symbols = set()
    for item in most_active:
        all_symbols.add(item["symbol"])
    for item in top_movers:
        all_symbols.add(item["symbol"])
    for sym in trending:
        all_symbols.add(sym)

    # Remove symbols already in watchlist (they get researched separately)
    watchlist_symbols = set(get_tradeable_symbols())
    new_symbols = all_symbols - watchlist_symbols
    # Remove SPY, common ETFs, and leveraged/inverse products
    exclude = {
        # Index ETFs
        "SPY", "QQQ", "DIA", "IWM",
        # Hedge instruments — managed by manage_bear_hedge, not by screener
        "SH",
        # Volatility products
        "VXX", "UVXY", "SVXY", "VIXY",
        # Leveraged / inverse ETFs
        "SQQQ", "TQQQ", "SPXU", "SPXS", "UPRO", "SPXL",
        "SOXL", "SOXS", "LABU", "LABD", "FNGU", "FNGD",
        "TNA", "TZA", "FAS", "FAZ", "NUGT", "DUST",
        "JNUG", "JDST", "ERX", "ERY", "TECL", "TECS",
        "UDOW", "SDOW", "YANG", "YINN", "CURE", "DRIP",
        "GUSH", "UCO", "SCO", "BOIL", "KOLD", "WEBL", "WEBS",
        "BULZ", "BERZ", "NAIL", "DRV", "TMF", "TMV",
        # Single-stock leveraged / inverse ETFs
        "NVDL", "NVDD", "AMDL", "AMDS", "TSLL", "TSLS",
        "MSFU", "MSFD", "AAPU", "AAPD", "AMZU", "AMZD",
        "GOGL", "METV", "CONL", "CONY", "NFLP", "BITO",
    }
    new_symbols -= exclude

    # Filter out warrants (symbols ending in W with 4+ chars, e.g. ABCDW)
    new_symbols = {s for s in new_symbols if not (len(s) >= 4 and s.endswith("W"))}

    # Filter out units and rights (ending in U or R with 4+ chars)
    new_symbols = {s for s in new_symbols if not (len(s) >= 4 and s[-1] in ("U", "R") and s[:-1].isalpha())}

    # Filter out warrants/rights with dot notation (e.g. KCAC.WS, DHY.RT)
    new_symbols = {s for s in new_symbols if ".WS" not in s and ".RT" not in s and ".WT" not in s}

    log.info(f"Unique screener candidates (excluding watchlist): {len(new_symbols)}")

    # Pre-filter: check Alpaca asset name to remove leveraged/inverse ETFs
    from alpaca.trading.client import TradingClient
    _tc = TradingClient(ALPACA_API_KEY, ALPACA_SECRET_KEY, paper=True)
    filtered_symbols = set()
    leveraged_keywords = [
        "2x", "3x", "-2x", "-3x", "leveraged", "inverse", "ultra",
        "direxion", "proshares", "graniteshares", "microsectors",
        "short", "bear", "bull 3x", "bull 2x",
    ]
    for symbol in sorted(new_symbols):
        try:
            asset = _tc.get_asset(symbol)
            name = (asset.name or "").lower()
            if any(kw in name for kw in leveraged_keywords):
                log.info(f"  {symbol}: skipping leveraged/inverse product ({asset.name})")
                continue
            filtered_symbols.add(symbol)
        except Exception:
            filtered_symbols.add(symbol)  # if API fails, keep it for now

    log.info(f"After leveraged filter: {len(filtered_symbols)} candidates (removed {len(new_symbols) - len(filtered_symbols)})")

    # Score top candidates
    scored = {}
    for symbol in sorted(filtered_symbols)[:30]:  # cap at 30 to avoid rate limits
        try:
            log.info(f"Screening {symbol}...")
            df = get_bars(symbol, days=60)
            if len(df) < 20:
                log.warning(f"  {symbol}: insufficient data ({len(df)} bars)")
                continue

            technicals = compute_technicals(df)
            if "error" in technicals:
                continue

            # Skip penny stocks under $5
            if technicals.get("price", 0) < 5.0:
                log.info(f"  {symbol}: price ${technicals['price']:.2f} < $5 — skipping")
                continue

            # Get news
            try:
                news = get_news(symbol, limit=5)
                n_score = score_news(news)
                headlines = [a["headline"] for a in news[:3]]
            except Exception:
                n_score = 5
                headlines = []

            confidence = compute_confidence_score(technicals, n_score)

            scored[symbol] = {
                "technicals": technicals,
                "news_score": n_score,
                "news_headlines": headlines,
                "confidence": confidence,
                "source": "screener",
            }
            log.info(f"  {symbol}: ${technicals['price']:.2f} | Score: {confidence['total']} ({confidence['action']})")

        except Exception as e:
            log.warning(f"  {symbol}: screening failed — {e}")

    # Build result
    result = {
        "updated_at": get_now_str(),
        "most_active": most_active,
        "top_movers": top_movers,
        "trending": trending,
        "scored_candidates": scored,
    }

    save_json(SCREENER_STATE, result)
    log.info(f"Screener results saved to {SCREENER_STATE} ({len(scored)} scored)")
    return result


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "full"

    if cmd == "active":
        results = get_most_active()
        print(f"\nMost Active Stocks ({len(results)}):")
        for r in results[:20]:
            print(f"  {r['symbol']:>6s}  vol={r['volume']:>12,}  trades={r['trade_count']:>8,}")

    elif cmd == "movers":
        results = get_top_movers()
        print(f"\nTop Movers ({len(results)}):")
        for r in results[:20]:
            print(f"  {r['symbol']:>6s}  {r['change_pct']:>+7.2f}%  ${r['price']:.2f}")

    elif cmd == "trending":
        results = query_trending_from_perplexity()
        print(f"\nTrending Tickers ({len(results)}):")
        for t in results:
            print(f"  {t}")

    elif cmd == "full":
        result = run_full_screen()
        print(f"\nFull Screen Complete:")
        print(f"  Most Active: {len(result['most_active'])} stocks")
        print(f"  Top Movers:  {len(result['top_movers'])} stocks")
        print(f"  Trending:    {len(result['trending'])} tickers")
        print(f"  Scored:      {len(result['scored_candidates'])} candidates")
        if result["scored_candidates"]:
            print(f"\nTop Scored Candidates:")
            sorted_candidates = sorted(
                result["scored_candidates"].items(),
                key=lambda x: x[1]["confidence"]["total"],
                reverse=True,
            )
            for sym, data in sorted_candidates[:10]:
                c = data["confidence"]
                t = data["technicals"]
                print(f"  {sym:>6s}: ${t['price']:.2f} | Score: {c['total']} ({c['action']}) | RSI: {t.get('rsi_14', 0):.1f}")

    else:
        print("Usage: python3 screener.py [active|movers|trending|full]")
