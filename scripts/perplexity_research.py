"""Deep research via Perplexity API — catalyst analysis, market outlook."""

import sys
import json
import requests

from utils import (
    PERPLEXITY_API_KEY, RESEARCH_STATE,
    setup_logging, get_now_str, load_json, save_json,
)

log = setup_logging("perplexity")

PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions"


def query_perplexity(prompt: str, model: str = "sonar") -> str:
    """Send a query to Perplexity API and return the response text."""
    headers = {
        "Authorization": f"Bearer {PERPLEXITY_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a financial research analyst. Provide concise, data-driven analysis. Always include specific numbers, dates, and sources when possible."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 1024,
        "temperature": 0.1,
    }
    resp = requests.post(PERPLEXITY_URL, headers=headers, json=payload, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def analyze_stock_catalyst(symbol: str) -> dict:
    """Deep-dive catalyst analysis for a stock. Returns sentiment + score (0-30)."""
    prompt = f"""Analyze the current investment catalysts for {symbol} stock. Consider:

1. Recent earnings results or upcoming earnings (date, estimates, surprises)
2. Product launches, partnerships, or major announcements in the last 2 weeks
3. Analyst upgrades/downgrades and price target changes
4. Sector/macro tailwinds or headwinds
5. Any regulatory, legal, or competitive risks

Provide:
- SENTIMENT: one of [STRONG_POSITIVE, POSITIVE, NEUTRAL, NEGATIVE, STRONG_NEGATIVE]
- CATALYST_SCORE: integer 0-30 based on strength of catalysts
- KEY_CATALYST: one sentence summary of the most important catalyst
- RISK: one sentence on the biggest risk
- TIMEFRAME: is this a short-term (1-5 day) or medium-term (5-20 day) play?

Format your response as JSON with these exact keys."""

    try:
        response = query_perplexity(prompt)
        # Try to parse JSON from response
        # Handle case where response has markdown code blocks
        cleaned = response.strip()
        if "```json" in cleaned:
            cleaned = cleaned.split("```json")[1].split("```")[0].strip()
        elif "```" in cleaned:
            cleaned = cleaned.split("```")[1].split("```")[0].strip()

        try:
            result = json.loads(cleaned)
        except json.JSONDecodeError:
            # Fallback: extract key info from text
            result = {
                "SENTIMENT": "NEUTRAL",
                "CATALYST_SCORE": 15,
                "KEY_CATALYST": response[:200],
                "RISK": "Unable to parse structured response",
                "TIMEFRAME": "unknown",
            }

        # Normalize score to 0-30 range
        score = int(result.get("CATALYST_SCORE", 15))
        score = max(0, min(30, score))

        return {
            "symbol": symbol,
            "sentiment": result.get("SENTIMENT", "NEUTRAL"),
            "perplexity_score": score,
            "key_catalyst": result.get("KEY_CATALYST", ""),
            "risk": result.get("RISK", ""),
            "timeframe": result.get("TIMEFRAME", ""),
            "raw_response": response[:500],
            "updated_at": get_now_str(),
        }

    except Exception as e:
        log.error(f"Perplexity analysis failed for {symbol}: {e}")
        return {
            "symbol": symbol,
            "sentiment": "UNKNOWN",
            "perplexity_score": 0,
            "key_catalyst": f"Error: {e}",
            "risk": "",
            "timeframe": "",
            "updated_at": get_now_str(),
        }


def get_market_outlook() -> dict:
    """Get overall market outlook from Perplexity."""
    prompt = """Provide a brief market outlook for US equities today. Cover:

1. Key index levels (S&P 500, Nasdaq, Dow)
2. Major macro events today/this week (Fed, economic data, earnings)
3. Sector rotation trends
4. Market sentiment (fear/greed, VIX level)
5. Top 3 stocks in the news today and why

Keep it concise and actionable for a swing trader with a 2-10 day horizon."""

    try:
        response = query_perplexity(prompt)
        return {
            "outlook": response,
            "updated_at": get_now_str(),
        }
    except Exception as e:
        log.error(f"Market outlook failed: {e}")
        return {"outlook": f"Error: {e}", "updated_at": get_now_str()}


def get_sector_analysis(sector: str) -> dict:
    """Get sector-specific analysis."""
    prompt = f"""Analyze the current state of the {sector} sector for US equities:

1. Key trends and drivers in the last 2 weeks
2. Top performing and worst performing stocks
3. Upcoming catalysts (earnings, product launches, regulatory)
4. Valuation assessment (expensive/fair/cheap relative to history)
5. Recommendation: overweight, neutral, or underweight for the next 2-4 weeks

Keep it concise and data-driven."""

    try:
        response = query_perplexity(prompt)
        return {
            "sector": sector,
            "analysis": response,
            "updated_at": get_now_str(),
        }
    except Exception as e:
        log.error(f"Sector analysis failed for {sector}: {e}")
        return {"sector": sector, "analysis": f"Error: {e}", "updated_at": get_now_str()}


def enhance_research_with_perplexity() -> dict:
    """Enhance research.json with Perplexity scores for promising candidates."""
    research = load_json(RESEARCH_STATE)
    if not research or "symbols" not in research:
        log.warning("No research data found. Run research.py report first.")
        return {}

    regime = research.get("spy", {}).get("market_regime", "NEUTRAL")
    spy_20d = research.get("spy", {}).get("twenty_day_return", 0.0)

    enhanced_count = 0
    for symbol, data in research["symbols"].items():
        if "error" in data:
            continue

        # Only run Perplexity for candidates with preliminary score >= 25
        confidence = data.get("confidence", {})
        prelim_score = confidence.get("technical_score", 0) + confidence.get("news_score", 0)
        if prelim_score < 25:
            log.info(f"Skipping {symbol} — preliminary score {prelim_score} < 25")
            continue

        log.info(f"Enhancing {symbol} with Perplexity (prelim score: {prelim_score})...")
        catalyst = analyze_stock_catalyst(symbol)
        data["perplexity"] = catalyst

        # Recompute confidence with Perplexity score
        from research import compute_confidence_score
        new_confidence = compute_confidence_score(
            data["technicals"],
            confidence["news_score"],
            catalyst["perplexity_score"],
            regime=regime,
            spy_20d_return=spy_20d,
        )
        data["confidence"] = new_confidence
        enhanced_count += 1

        log.info(f"  {symbol}: Perplexity={catalyst['perplexity_score']}/30 | "
                 f"Total={new_confidence['total']} ({new_confidence['action']}) | "
                 f"{catalyst['sentiment']}")

    research["perplexity_enhanced_at"] = get_now_str()
    save_json(RESEARCH_STATE, research)
    log.info(f"Enhanced {enhanced_count} symbols with Perplexity data.")
    return research


def enhance_screener_with_perplexity() -> dict:
    """Enhance screener.json top candidates with Perplexity scores."""
    from utils import SCREENER_STATE
    screener = load_json(SCREENER_STATE)
    if not screener or "scored_candidates" not in screener:
        log.warning("No screener data found. Run screener.py full first.")
        return {}

    # Sort by preliminary score, take top 5 with prelim >= 25
    candidates = []
    for symbol, data in screener["scored_candidates"].items():
        if "error" in data:
            continue
        confidence = data.get("confidence", {})
        prelim_score = confidence.get("technical_score", 0) + confidence.get("news_score", 0)
        if prelim_score >= 25:
            candidates.append((symbol, data, prelim_score))

    candidates.sort(key=lambda x: x[2], reverse=True)
    candidates = candidates[:5]

    if not candidates:
        log.info("No screener candidates with prelim score >= 25")
        return screener

    # Get regime/SPY data for scoring
    research = load_json(RESEARCH_STATE)
    regime = research.get("spy", {}).get("market_regime", "NEUTRAL")
    spy_20d = research.get("spy", {}).get("twenty_day_return", 0.0)

    enhanced_count = 0
    for symbol, data, prelim_score in candidates:
        log.info(f"Enhancing screener candidate {symbol} (prelim score: {prelim_score})...")
        catalyst = analyze_stock_catalyst(symbol)
        data["perplexity"] = catalyst

        # Recompute confidence with Perplexity score
        from research import compute_confidence_score
        confidence = data["confidence"]
        new_confidence = compute_confidence_score(
            data["technicals"],
            confidence["news_score"],
            catalyst["perplexity_score"],
            regime=regime,
            spy_20d_return=spy_20d,
        )
        data["confidence"] = new_confidence
        screener["scored_candidates"][symbol] = data
        enhanced_count += 1

        log.info(f"  {symbol}: Perplexity={catalyst['perplexity_score']}/30 | "
                 f"Total={new_confidence['total']} ({new_confidence['action']}) | "
                 f"{catalyst['sentiment']}")

    screener["perplexity_enhanced_at"] = get_now_str()
    save_json(SCREENER_STATE, screener)
    log.info(f"Enhanced {enhanced_count} screener candidates with Perplexity data.")
    return screener


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "outlook"

    if cmd == "outlook":
        result = get_market_outlook()
        print(f"\n{'='*60}")
        print("  MARKET OUTLOOK")
        print(f"{'='*60}")
        print(result["outlook"])
        print(f"\nUpdated: {result['updated_at']}")

    elif cmd == "stock" and len(sys.argv) > 2:
        symbol = sys.argv[2].upper()
        result = analyze_stock_catalyst(symbol)
        print(f"\n{'='*60}")
        print(f"  {symbol} CATALYST ANALYSIS")
        print(f"{'='*60}")
        print(f"  Sentiment: {result['sentiment']}")
        print(f"  Score: {result['perplexity_score']}/30")
        print(f"  Catalyst: {result['key_catalyst']}")
        print(f"  Risk: {result['risk']}")
        print(f"  Timeframe: {result['timeframe']}")

    elif cmd == "sector" and len(sys.argv) > 2:
        sector = " ".join(sys.argv[2:])
        result = get_sector_analysis(sector)
        print(f"\n{'='*60}")
        print(f"  {sector.upper()} SECTOR ANALYSIS")
        print(f"{'='*60}")
        print(result["analysis"])

    elif cmd == "enhance":
        result = enhance_research_with_perplexity()
        if result:
            print(f"\nEnhanced research saved. Symbols analyzed:")
            for sym, data in result.get("symbols", {}).items():
                if "perplexity" in data:
                    c = data["confidence"]
                    px = data["perplexity"]
                    print(f"  {sym}: Score={c['total']} ({c['action']}) | Perplexity={px['perplexity_score']}/30 | {px['sentiment']}")

    elif cmd == "enhance-screener":
        result = enhance_screener_with_perplexity()
        if result:
            print(f"\nEnhanced screener saved. Candidates analyzed:")
            for sym, data in result.get("scored_candidates", {}).items():
                if "perplexity" in data:
                    c = data["confidence"]
                    px = data["perplexity"]
                    print(f"  {sym}: Score={c['total']} ({c['action']}) | Perplexity={px['perplexity_score']}/30 | {px['sentiment']}")

    else:
        print("Usage: python3 perplexity_research.py [outlook|stock SYMBOL|sector NAME|enhance|enhance-screener]")
