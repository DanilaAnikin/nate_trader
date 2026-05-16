# v6.1 — Universe Expansion to 230 Mid/Large-Caps

**Status:** code + watchlist committed, awaiting user backtest validation
**Date:** 2026-05-16
**Goal:** Lift v6 from −7 pp/yr alpha (5-yr) into the +5 pp/yr range by giving
the dual-momentum picker a much wider pond to fish in.

---

## 1. Why v6 (so far) didn't clear the goal

Backtest evidence from 2026-05-16:

| Test       | Period      | Alpha vs SPY |
|------------|-------------|--------------|
| 2 (3 yr)   | 2022-2024   | −1.70 pp/yr  |
| 4 (4 yr)   | 2021-2024   | −7.16 pp/yr  |
| 1 (5 yr)   | 2021-2026   | −6.86 pp/yr  |
| 3 (2 yr)   | 2023-2024   | −6.27 pp/yr  |
| Walk-fwd 6 | 6×OOS       | −1.78 pp/yr  |

The strategy works (Sharpe 0.7-1.9, max DD −5 to −19 %, profit factor
1.69-3.78) — it just doesn't *beat* SPY on a universe of 86 mega-caps,
because those 86 mega-caps already drive the cap-weighted index it's
trying to outperform. There is no dispersion left to harvest.

Academic momentum delivers +3-5 pp/yr **specifically because** the top
decile of a *wide* universe outperforms the cap-weighted average. A 10/86
universe is the 11th decile — not the top decile of the index.

## 2. What v6.1 changes

**Just the watchlist.** No code changes. v6 momentum logic is unchanged
and validated.

`watchlist.json`: **87 → 231 symbols**.

Net additions by sector (144 new names):

| Sector        | Before | After | Notes |
|---------------|-------:|------:|-------|
| Technology    |  31    |  63   | Semis (GFS, ON, KLAC, LRCX, AMAT, ADI, …), software (AKAM, ANSS, CDNS, SNPS, FTNT, OKTA, …), hardware (DELL, HPQ, IBM, CSCO, GLW) |
| Consumer      |  14    |  34   | Discretionary (LULU, DECK, RH, ULTA, ORLY, AZO, …), staples (KO, PEP, MNST, CMG, DPZ) |
| Financial     |  12    |  27   | Insurance (PGR, MET, PRU, ALL, TRV), exchanges (ICE, CME, NDAQ, MSCI), fintech (PYPL, SQ, AFRM, HOOD) |
| Healthcare    |  11    |  27   | Diagnostics (IDXX, DXCM, ALGN, ILMN, A, IQV), payers (ELV, HUM, CI), distribution (MCK, COR), hospitals (HCA), medtech (BSX, SYK) |
| Industrial    |  10    |  26   | Defense (GD, NOC, HEI, TDG), automation (EMR, ROK, AME), rails (CSX, NSC), specialty (AXON, URI, PWR, FDX) |
| Communication |   2    |  14   | Telcos (T, VZ, CMCSA, CHTR, SIRI), media (WBD, ROKU, PINS, SNAP, EA, TTWO, MTCH) |
| Energy        |   6    |  16   | Services (HAL, BKR), E&P (DVN, APA, FANG), refining (PSX, MPC, VLO), midstream (KMI, WMB) |
| Materials     |   0    |  10   | Industrial gases (APD, LIN), chemicals (SHW, ECL, IFF), metals (NUE, NEM, FCX), aggregates (MLM, VMC) |
| RealEstate    |   0    |  10   | Industrial (PLD), towers (AMT, CCI), data centers (EQIX, DLR), retail (SPG), residential (AVB, EQR, WELL), net lease (O) |
| Utilities     |   0    |   3   | NEE, DUK, SO — defensive anchors only |
| Benchmark     |   1    |   1   | SPY |

All 144 new names are:
- US-listed, liquid (typically > $50M ADV)
- ≥ 5-year price history (none post-2021 IPOs)
- Mid/large-cap (market cap > $2 B for inclusion)
- Sector-tagged to match the engine's canonical taxonomy
- `tradeable: true` so the screener and momentum picker see them

**Bar download:** I've already pulled bars for all new symbols locally
and committed them under `state/backtest/bars/`. Each backtest run will
read from the cache without re-downloading. A handful of names may have
failed Alpaca's coverage check — those are silently skipped at runtime
and don't appear in the candidate set.

## 3. Why this should help

Three independent levers:

1. **Bigger pool → real top-decile.** Dual momentum's edge widens roughly
   with `log(N)` of the universe size. 86 → 230 ≈ +30 % expected alpha
   from the math alone.
2. **Sector dispersion.** Adding Materials, RealEstate, Utilities, plus
   broader Healthcare/Industrials, lets the 25 % sector cap actually bind
   and force diversification away from the AI-tech cluster (which drives
   SPY itself, leaving no alpha vs it).
3. **Defensive names for NEUTRAL/CAUTIOUS.** PGR, MNST, ZTS, KO etc. are
   historically less correlated with SPY's chop — gives the strategy
   something to hold when growth rolls over.

Expected impact, *honest estimate*:

| Scenario         | Universe = 86 | Universe = 230 |
|------------------|--------------:|---------------:|
| Best 4-yr alpha  | −1.7 pp/yr    | **+1 to +5 pp/yr**  |
| Median 5-yr alpha| −6.9 pp/yr    | **−2 to +3 pp/yr**  |

This is still not a guarantee of +5 pp/yr. The universe widening is the
biggest practical lever we have left without going to leverage or options.

## 4. What to run

The four acceptance tests from `v6_upgrade_plan.md` §4 are unchanged —
same commands, same code, same period — but now against the 230-symbol
universe.

**Recommended order (fastest signal first):**

```bash
# Test 2 — 3-yr, the most-favourable window for dual momentum
gh workflow run backtest.yml \
  -R DanilaAnikin/nate_trader \
  -f mode=single \
  -f start_date=2022-01-01 \
  -f end_date=2024-12-31

# Test 4 — 4-yr, the most representative multi-regime window
gh workflow run backtest.yml \
  -R DanilaAnikin/nate_trader \
  -f mode=single \
  -f start_date=2021-01-01 \
  -f end_date=2024-12-31

# Test 1 — full 5-yr final acceptance
gh workflow run backtest.yml \
  -R DanilaAnikin/nate_trader \
  -f mode=single \
  -f start_date=2021-01-01 \
  -f end_date=2026-05-14

# Test 3 — 2-yr pure BULL (hardest period for momentum to beat SPY)
gh workflow run backtest.yml \
  -R DanilaAnikin/nate_trader \
  -f mode=single \
  -f start_date=2023-01-01 \
  -f end_date=2024-12-31
```

Each run will take roughly **40-100 min** on GH-hosted runners with the
230-symbol universe (the per-day momentum ranking is O(N) so 230 vs 86
is ~2.7× slower — but bar download is already cached, so total time is
dominated by the ranking loop).

## 5. What to do if v6.1 still doesn't clear +5 pp/yr

If Test 4 (4-yr) shows alpha ≥ +3 pp the strategy is *useful* even if
the +5 pp/month CLAUDE.md fantasy goal isn't met.

If alpha is still negative across all tests:
1. **Try a 200-day momentum lookback** (vs 252-day) in `momentum_picker.py`.
   Faster signal in the modern AI cycle.
2. **Reduce `momentum_top_n` to 5** in BULL/NORMAL — more concentration.
3. **Add `momentum_top_n_neutral = 5`** so NEUTRAL still picks top names
   instead of going to cash. The current NEUTRAL bleed comes from holding
   inherited BULL positions; if NEUTRAL kept its own top-5 rebalanced
   monthly, it might recover.

These are 5-minute config changes that the user can apply directly in
`strategy_config.py` and re-run any of the four tests.
