"""CLI entry point for backtest framework.

Usage:
    python3 scripts/backtest/run.py single [--start YYYY-MM-DD] [--end YYYY-MM-DD]
    python3 scripts/backtest/run.py sweep
    python3 scripts/backtest/run.py monte-carlo [--n 200]
    python3 scripts/backtest/run.py download   # refresh historical bars first

All results land in state/backtest/*.json so the dashboard can render them.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import PROJECT_ROOT, setup_logging, save_json, get_now_str  # noqa: E402
from backtest.data_provider import BarProvider  # noqa: E402
from backtest.engine import BacktestConfig, run_backtest  # noqa: E402
from backtest.metrics import compute_metrics  # noqa: E402
from backtest.manifest import record_run  # noqa: E402

log = setup_logging("backtest_run")

RESULT_DIR = PROJECT_ROOT / "state" / "backtest"
RESULT_LATEST = RESULT_DIR / "latest_result.json"
RESULT_SWEEP = RESULT_DIR / "sweep_result.json"
RESULT_MONTE = RESULT_DIR / "monte_carlo_result.json"
RESULT_WALK = RESULT_DIR / "walk_forward_result.json"
RESULT_COMPARE = RESULT_DIR / "comparison_result.json"


def cmd_single(args) -> None:
    end = args.end or datetime.now().strftime("%Y-%m-%d")
    cfg = BacktestConfig(
        start_date=args.start,
        end_date=end,
        starting_cash=args.starting_cash,
    )
    result = run_backtest(cfg)
    provider = BarProvider()
    metrics = compute_metrics(result, provider)

    out = {
        "kind": "single",
        "generated_at": get_now_str(),
        "config": result["config"],
        "metrics": metrics,
        "daily_history": result["daily_history"],
        "closed_trades": result["closed_trades"],
        "open_positions": result["open_positions"],
    }
    run_id = record_run("single", out, latest_path=RESULT_LATEST)
    log.info(f"Saved → {RESULT_LATEST} (archived as runs/{run_id}.json)")

    print(f"\n{'=' * 60}")
    print(f"  BACKTEST RESULT")
    print(f"{'=' * 60}")
    print(f"  Period:           {cfg.start_date} → {cfg.end_date} ({metrics['n_trading_days']} days)")
    print(f"  Starting cash:    ${cfg.starting_cash:,.0f}")
    print(f"  Final equity:     ${result['final_equity']:,.0f}")
    print(f"  Total return:     {metrics['total_return_pct']:+.2f}%")
    print(f"  Annualized:       {metrics['annual_return_pct']:+.2f}%")
    print(f"  vs SPY total:     {metrics['spy_total_return_pct']:+.2f}%")
    print(f"  vs SPY annual:    {metrics['spy_annual_return_pct']:+.2f}%")
    print(f"  Alpha (annual):   {metrics['alpha_annual_pct']:+.2f}%")
    print(f"  Sharpe:           {metrics['sharpe_ratio']:.2f}")
    print(f"  Max drawdown:     {metrics['max_drawdown_pct']:.2f}%  "
          f"({metrics['max_drawdown_peak_date']} → {metrics['max_drawdown_trough_date']})")
    print(f"  Trades:           {metrics['n_trades']} (win rate {metrics['win_rate_pct']:.1f}%)")
    print(f"  Avg win:          {metrics['avg_win_pct']:+.2f}%   Avg loss: {metrics['avg_loss_pct']:+.2f}%")
    pf = metrics['profit_factor']
    print(f"  Profit factor:    {pf:.2f}" if pf is not None else "  Profit factor:    ∞ (no losses)")
    print(f"  Hedge contrib:    ${metrics['hedge_total_pnl']:+,.0f}  ({metrics['hedge_trades']} hedge trades)")
    print(f"\nTop 5 symbols by P&L:")
    for s in metrics["per_symbol"][:5]:
        print(f"  {s['symbol']:<6} ${s['pnl_total']:>+10,.0f}  ({s['wins']}/{s['trades']} wins, avg ${s['avg_pnl_per_trade']:+,.0f})")
    print(f"\nBottom 3 symbols:")
    for s in metrics["per_symbol"][-3:]:
        print(f"  {s['symbol']:<6} ${s['pnl_total']:>+10,.0f}  ({s['wins']}/{s['trades']} wins, avg ${s['avg_pnl_per_trade']:+,.0f})")
    print(f"\nRegime breakdown:")
    for r, b in metrics["regime_breakdown"].items():
        print(f"  {r:<8} {b['days']:>4}d ({b['pct_of_time']:.0f}%)  total_pnl={b['total_pnl_pct']:+.2f}%")


def cmd_sweep(args) -> None:
    from backtest.sweep import run_sweep
    end = args.end or datetime.now().strftime("%Y-%m-%d")
    grid = run_sweep(args.start, end, args.starting_cash)
    out = {
        "kind": "sweep",
        "generated_at": get_now_str(),
        "start_date": args.start,
        "end_date": end,
        "results": grid,
    }
    run_id = record_run("sweep", out, latest_path=RESULT_SWEEP)
    log.info(f"Saved → {RESULT_SWEEP} (archived as runs/{run_id}.json)")
    # Top 5
    sorted_grid = sorted(grid, key=lambda r: r["metrics"]["alpha_annual_pct"], reverse=True)
    print(f"\n{'=' * 70}")
    print(f"  TOP 5 PARAM SETS BY ANNUAL ALPHA")
    print(f"{'=' * 70}")
    for r in sorted_grid[:5]:
        p = r["params"]
        m = r["metrics"]
        print(f"  threshold={p.get('score_threshold_delta', 0):+d} | "
              f"risk={p.get('risk_per_trade_pct', '-')}% | "
              f"alpha={m['alpha_annual_pct']:+.2f}% | "
              f"sharpe={m['sharpe_ratio']:.2f} | "
              f"max_dd={m['max_drawdown_pct']:.1f}%")


def cmd_monte_carlo(args) -> None:
    from backtest.monte_carlo import run_monte_carlo
    end = args.end or datetime.now().strftime("%Y-%m-%d")
    result = run_monte_carlo(args.start, end, args.starting_cash, n_simulations=args.n)
    out = {
        "kind": "monte_carlo",
        "generated_at": get_now_str(),
        "start_date": args.start,
        "end_date": end,
        "n_simulations": args.n,
        **result,
    }
    run_id = record_run("monte_carlo", out, latest_path=RESULT_MONTE)
    log.info(f"Saved → {RESULT_MONTE} (archived as runs/{run_id}.json)")
    print(f"\n{'=' * 60}")
    print(f"  MONTE CARLO ({args.n} simulations)")
    print(f"{'=' * 60}")
    print(f"  Median final equity:   ${result['median_equity']:,.0f}")
    print(f"  5th percentile:        ${result['p5_equity']:,.0f}")
    print(f"  95th percentile:       ${result['p95_equity']:,.0f}")
    print(f"  Median alpha (annual): {result['median_alpha_pct']:+.2f}%")
    print(f"  P(beat SPY):           {result['prob_beat_spy_pct']:.1f}%")
    print(f"  Median max drawdown:   {result['median_max_dd_pct']:.2f}%")


def cmd_walk_forward(args) -> None:
    from backtest.walk_forward import run_walk_forward
    end = args.end or datetime.now().strftime("%Y-%m-%d")
    result = run_walk_forward(
        args.start, end, args.starting_cash,
        train_months=args.train_months,
        test_months=args.test_months,
        max_windows=args.windows,
    )
    out = {
        "kind": "walk_forward",
        "generated_at": get_now_str(),
        **result,
    }
    run_id = record_run("walk_forward", out, latest_path=RESULT_WALK)
    log.info(f"Saved → {RESULT_WALK} (archived as runs/{run_id}.json)")

    if "error" in result:
        print(f"\nERROR: {result['error']}")
        return

    print(f"\n{'=' * 60}")
    print(f"  WALK-FORWARD AGGREGATE")
    print(f"{'=' * 60}")
    agg = result["aggregate"]
    print(f"  Windows completed:    {agg['n_windows']}")
    print(f"  Mean OOS alpha (yr):  {agg['mean_oos_alpha_annual_pct']:+.2f}%")
    print(f"  Mean OOS Sharpe:      {agg['mean_oos_sharpe']:.2f}")
    print(f"  Mean OOS max DD:      {agg['mean_oos_max_drawdown_pct']:.2f}%")
    print(f"\n  Per-window OOS results:")
    for s in result["segments"]:
        bp = s["best_params"]
        tm = s["test_metrics"]
        print(f"    Win {s['window_index']}: train {s['train_start']}→{s['train_end']}  "
              f"test {s['test_start']}→{s['test_end']}")
        print(f"      best params: Δ={bp['threshold_delta']:+d} risk={bp['risk_per_trade_pct']}%")
        print(f"      OOS α={tm.get('alpha_annual_pct', 0):+.2f}%/yr  "
              f"sharpe={tm.get('sharpe_ratio', 0):.2f}  "
              f"DD={tm.get('max_drawdown_pct', 0):.1f}%")


def cmd_compare(args) -> None:
    from backtest.compare import run_compare
    end = args.end or datetime.now().strftime("%Y-%m-%d")
    result = run_compare(args.start, end, args.starting_cash)
    out = {
        "kind": "compare",
        "generated_at": get_now_str(),
        **result,
    }
    run_id = record_run("compare", out, latest_path=RESULT_COMPARE)
    log.info(f"Saved → {RESULT_COMPARE} (archived as runs/{run_id}.json)")

    if "error" in result:
        print(f"\nERROR: {result['error']}")
        return

    bm = result["baseline"]["metrics"]
    cm = result["challenger"]["metrics"]
    d = result["delta"]
    print(f"\n{'=' * 60}")
    print(f"  BASELINE vs CHALLENGER")
    print(f"{'=' * 60}")
    print(f"  {'':18}  {'baseline':>12}  {'challenger':>12}  {'Δ':>10}")
    print(f"  {'Annual return':18}  {bm['annual_return_pct']:>+11.2f}%  {cm['annual_return_pct']:>+11.2f}%  {cm['annual_return_pct'] - bm['annual_return_pct']:>+9.2f}pp")
    print(f"  {'Annual alpha':18}  {bm['alpha_annual_pct']:>+11.2f}%  {cm['alpha_annual_pct']:>+11.2f}%  {d['alpha_annual_pp']:>+9.2f}pp")
    print(f"  {'Sharpe':18}  {bm['sharpe_ratio']:>12.2f}   {cm['sharpe_ratio']:>12.2f}   {d['sharpe']:>+9.2f}")
    print(f"  {'Max drawdown':18}  {bm['max_drawdown_pct']:>+11.2f}%  {cm['max_drawdown_pct']:>+11.2f}%  {d['max_dd_pp']:>+9.2f}pp")
    print(f"  {'Trades':18}  {bm['n_trades']:>12}   {cm['n_trades']:>12}")
    print(f"  Challenger params: {result['challenger']['params']}")


def cmd_download(args) -> None:
    from backtest.download_history import main as download_main
    extra = []
    if args.start:
        extra.extend(["--start", args.start])
    download_main(extra)


def main() -> None:
    parser = argparse.ArgumentParser(prog="backtest", description="Nate Trader backtest framework")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_single = sub.add_parser("single", help="Run one backtest with live default params")
    p_single.add_argument("--start", default="2021-01-01")
    p_single.add_argument("--end", default=None)
    p_single.add_argument("--starting-cash", type=float, default=1_000_000)

    p_sweep = sub.add_parser("sweep", help="Grid search over key parameters")
    p_sweep.add_argument("--start", default="2021-01-01")
    p_sweep.add_argument("--end", default=None)
    p_sweep.add_argument("--starting-cash", type=float, default=1_000_000)

    p_monte = sub.add_parser("monte-carlo", help="Monte Carlo bootstrap of daily returns")
    p_monte.add_argument("--start", default="2021-01-01")
    p_monte.add_argument("--end", default=None)
    p_monte.add_argument("--starting-cash", type=float, default=1_000_000)
    p_monte.add_argument("--n", type=int, default=200)

    p_walk = sub.add_parser("walk-forward", help="Walk-forward parameter optimization")
    p_walk.add_argument("--start", default="2021-01-01")
    p_walk.add_argument("--end", default=None)
    p_walk.add_argument("--starting-cash", type=float, default=1_000_000)
    p_walk.add_argument("--train-months", type=int, default=12)
    p_walk.add_argument("--test-months", type=int, default=6)
    p_walk.add_argument("--windows", type=int, default=3)

    p_cmp = sub.add_parser("compare", help="Compare baseline vs sweep-best params")
    p_cmp.add_argument("--start", default="2021-01-01")
    p_cmp.add_argument("--end", default=None)
    p_cmp.add_argument("--starting-cash", type=float, default=1_000_000)

    p_dl = sub.add_parser("download", help="Download / refresh historical bars")
    p_dl.add_argument("--start", default=None)

    args = parser.parse_args()
    if args.cmd == "single":
        cmd_single(args)
    elif args.cmd == "sweep":
        cmd_sweep(args)
    elif args.cmd == "monte-carlo":
        cmd_monte_carlo(args)
    elif args.cmd == "walk-forward":
        cmd_walk_forward(args)
    elif args.cmd == "compare":
        cmd_compare(args)
    elif args.cmd == "download":
        cmd_download(args)


if __name__ == "__main__":
    main()
