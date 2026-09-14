# V11: malé účty a celé akcie

**NONPROMOTABLE — oddělená historická studie, bez změny strategie a bez pokynů brokerovi.**

Každé období začíná znovu s uvedenou hotovostí. Parametry V11 zůstávají beze změny; mění se pouze počáteční kapitál a model nákladů.

## Výsledky

Expozice je průměr investované části účtu při denním ocenění na open. Obchody jsou skutečně simulované nákupní/prodejní transakce; ne počet uzavřených pozic. Náklady jsou již zahrnuté v konečné hodnotě.

### DEVELOPMENT / model-building period (2021-01-04 až 2024-12-31)

| Účet USD | Náklad bps / strana | Konec USD | Výnos % | Max. propad % | Prům. expozice % | Dní jen hotovost | Nákupy/prodeje | Náklady USD |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 7 | 100.00 | 0.00 | 0.00 | 0.00 | 1005/1005 | 0/0 | 0.00 |
| 100 | 15 | 100.00 | 0.00 | 0.00 | 0.00 | 1005/1005 | 0/0 | 0.00 |
| 100 | 25 | 100.00 | 0.00 | 0.00 | 0.00 | 1005/1005 | 0/0 | 0.00 |
| 250 | 7 | 429.16 | 71.66 | -11.40 | 16.19 | 151/1005 | 20/17 | 0.59 |
| 250 | 15 | 428.48 | 71.39 | -11.43 | 16.21 | 151/1005 | 20/17 | 1.27 |
| 250 | 25 | 420.62 | 68.25 | -11.67 | 16.11 | 171/1005 | 18/16 | 1.95 |
| 500 | 7 | 1216.54 | 143.31 | -14.52 | 35.23 | 41/1005 | 77/66 | 4.82 |
| 500 | 15 | 1211.33 | 142.27 | -14.58 | 35.33 | 41/1005 | 77/66 | 10.33 |
| 500 | 25 | 1200.58 | 140.12 | -14.71 | 35.42 | 41/1005 | 77/66 | 17.22 |
| 1000 | 7 | 2961.05 | 196.11 | -15.94 | 51.53 | 0/1005 | 195/172 | 21.98 |
| 1000 | 15 | 2935.61 | 193.56 | -15.96 | 51.60 | 0/1005 | 192/172 | 46.74 |
| 1000 | 25 | 2735.07 | 173.51 | -16.51 | 50.82 | 0/1005 | 185/166 | 73.12 |

SPY, zlomkový beznákladový index open–open: **66.43 %**. Jde o referenční vývoj trhu; za každý uvedený účet nelze koupit celou akcii SPY. Varianta SPY s celými akciemi, vstupními náklady a hotovostí je v JSON.

### REUSED TEMPORAL CHECK / not fresh OOS (2025-01-02 až 2026-09-04)

| Účet USD | Náklad bps / strana | Konec USD | Výnos % | Max. propad % | Prům. expozice % | Dní jen hotovost | Nákupy/prodeje | Náklady USD |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 7 | 100.00 | 0.00 | 0.00 | 0.00 | 420/420 | 0/0 | 0.00 |
| 100 | 15 | 100.00 | 0.00 | 0.00 | 0.00 | 420/420 | 0/0 | 0.00 |
| 100 | 25 | 100.00 | 0.00 | 0.00 | 0.00 | 420/420 | 0/0 | 0.00 |
| 250 | 7 | 249.40 | -0.24 | -3.72 | 3.61 | 291/420 | 3/3 | 0.09 |
| 250 | 15 | 249.30 | -0.28 | -3.73 | 3.61 | 291/420 | 3/3 | 0.19 |
| 250 | 25 | 249.18 | -0.33 | -3.75 | 3.62 | 291/420 | 3/3 | 0.31 |
| 500 | 7 | 508.38 | 1.68 | -6.38 | 11.30 | 104/420 | 11/9 | 0.49 |
| 500 | 15 | 507.83 | 1.57 | -6.41 | 11.31 | 104/420 | 11/9 | 1.04 |
| 500 | 25 | 507.13 | 1.43 | -6.45 | 11.32 | 104/420 | 11/9 | 1.74 |
| 1000 | 7 | 1085.41 | 8.54 | -8.17 | 23.43 | 1/420 | 40/30 | 3.19 |
| 1000 | 15 | 1083.89 | 8.39 | -8.21 | 23.43 | 1/420 | 40/30 | 6.82 |
| 1000 | 25 | 1079.66 | 7.97 | -8.25 | 23.45 | 1/420 | 40/30 | 11.37 |

SPY, zlomkový beznákladový index open–open: **33.23 %**. Jde o referenční vývoj trhu; za každý uvedený účet nelze koupit celou akcii SPY. Varianta SPY s celými akciemi, vstupními náklady a hotovostí je v JSON.

## Dosažitelnost pozic při 7 bps

| Období | Účet USD | Max. počet pozic | Dní s omezením celými akciemi | Nedostupný celý cílový titul × den |
|---|---:|---:|---:|---:|
| development | 100 | 0 | 1005 | 10050 |
| temporal_check | 100 | 0 | 420 | 4200 |
| development | 250 | 4 | 1005 | 8572 |
| temporal_check | 250 | 2 | 420 | 4048 |
| development | 500 | 8 | 1005 | 5611 |
| temporal_check | 500 | 3 | 420 | 3591 |
| development | 1000 | 10 | 1005 | 2745 |
| temporal_check | 1000 | 6 | 420 | 2783 |

Opakovaný nedostupný titul se počítá v každém dni čekajícího plánu. Počty zahrnují stav po provedení plánu, včetně čekání po prodeji; nejsou to odmítnuté ani odeslané pokyny.

## Omezení a reprodukce

- NONPROMOTABLE: isolated research; does not approve or change any release or policy.
- Current local universe membership, not point-in-time constituents; survivorship and missing delistings can bias results.
- Both periods have already been inspected during development; the later period is a REUSED TEMPORAL CHECK, not fresh OOS.
- Integer units use adjusted historical OHLC prices. Splits/dividend adjustments can make historical nominal share affordability differ; this is the existing engine's policy sensitivity, not an exact historical broker replay.
- Signals use completed prior-session data; fills and daily valuation use the next session's open. Intraday drawdowns are not measured.
- Costs are adverse 7/15/25 bps on each buy and sell. They are already included in equity; no separate commissions, regulatory fees, taxes, market impact or stochastic/partial fills are simulated.
- Cash earns zero. Each period starts independently in cash; there are no deposits, withdrawals, capital transfers or live account records.
- SPY percentage benchmark is a frictionless fractional open-to-open reference. The additional integer-SPY example includes entry slippage and idle cash, has no exit liquidation, and may buy zero shares.
- Whole-share blocked counts are observations of material target shortfalls on pending-plan sessions, not broker rejections or distinct order attempts; one frozen target can recur on many days.
- No optimization, fractionals, alternate ranking, minimum-position relaxation, or changes to the frozen V11 allocation/risk rules. Historical results do not establish future returns.

Lokální ranking: **532 symbolů**, 903795 řádků včetně pomocných ETF, poslední datum 2026-09-04.
SHA256 datového prefixu: `d86303ec9a9fb3ff57b681f85696a68949eea96f7fab691fb8fc9ba5c886e6b5`.
SHA256 ranking univerza: `169f440d4b5cec74e9d2aacab36ccb1de626f96ec6efbf6e75f34a86ee87d152`.
SHA256 zdrojů studie: `1c7b63f6c6f77f46b417b8a4fe2085abe75795ce0261c933233e81911cf04437`. Přesné soubory a jejich hashe jsou v JSON; není to schválená produkční identita.

Spuštění z kořene stejného checkoutu a dat: `PYTHON_DOTENV_DISABLED=1 .venv/bin/python scripts/backtest/small_account_study.py --output-dir docs/research/small-account-repeat`.

[Úplný JSON (gzip): metriky, transakce, denní průběhy, omezení a původ dat](study.json.gz)
