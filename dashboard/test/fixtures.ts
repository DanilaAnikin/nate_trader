/**
 * Fixtures mirroring the real shapes of every V11 observability source.
 *
 * Values are structurally faithful to production artifacts (schema versions,
 * key names, nesting) so a schema drift in the Python runner breaks a test
 * rather than a production screen.
 */

import { parsePreflight } from "@/lib/status/parse";
import type { PreflightInfo, ValidationInfo } from "@/lib/status/types";

export const APPROVED_SHA = "0cb02c0765ebf91e60e5efd7f51334e9b538fbcb";
export const OTHER_SHA = "1111111111111111111111111111111111111111";
export const DASHBOARD_SHA = "d11bbad8aad7ec98596b0d290cb938706982d069";
export const REPO_SHA = "49cd8bda494550f1b8b7b2232eb7af6fe92e9390";

export const STRATEGY_IDENTITY =
  "0cedd11966adff49ecb32b8cd84947efacbe5be8eeb35c1182f4c2f0411982be";
export const UNIVERSE_HASH =
  "c86dc489c62625cd380dae6c105e28ee3dbe9aa124363b4dcd1a9f932bafa074";
/** Adjusted-bar prefix digest, as `state/backtest/v11_validation.json` records it. */
export const BAR_SNAPSHOT_SHA256 =
  "d55b0f56c52ee23b351fb8746f7b984a6b0ace3dd34bbfeffcd2ada25a56ade3";
/** Whole-report tamper-evident digest. */
export const REPORT_SHA256 =
  "33c94500a23d3e29834e7196c96b70e630cd3ab4afe8718f9bde02f3d380e5bc";

export const TARGET_SYMBOLS = [
  "ASML",
  "CASY",
  "CAT",
  "MPC",
  "MRK",
  "PANW",
  "ROST",
  "UNH",
  "VLO",
  "VRT",
] as const;

const SECTORS: Record<string, string> = {
  ASML: "Technology",
  CASY: "Consumer",
  CAT: "Industrial",
  MPC: "Energy",
  MRK: "Healthcare",
  PANW: "Technology",
  ROST: "Consumer",
  UNH: "Healthcare",
  VLO: "Energy",
  VRT: "Industrial",
};

/** A schema-v3 frozen plan, including the raw order-attempt records. */
export function frozenPlanJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 3,
    plan_id: "f8756105eb63dde2",
    rebalance_month: "2026-08",
    signal_date: "2026-08-03",
    target_weights: Object.fromEntries(
      TARGET_SYMBOLS.map((symbol) => [symbol, 0.045]),
    ),
    sector_by_symbol: Object.fromEntries(
      TARGET_SYMBOLS.map((symbol) => [symbol, SECTORS[symbol]]),
    ),
    risk_off: false,
    strategy_identity_value: STRATEGY_IDENTITY,
    ranking_universe_sha256: UNIVERSE_HASH,
    construction_risk_tier: "CAUTIOUS",
    eligible_count: 78,
    created_at: "2026-08-07 12:05:03",
    order_attempts: {
      cc71157a73726c12: {
        attempt: 1,
        client_order_id: "nt-adaptive-asml-sell-aeccfc32b994",
        status: "submitted",
        symbol: "ASML",
        side: "sell",
        quantity: 23.0,
        target_weight: 0.045,
        reserved_at: "2026-08-07 12:05:03",
        order_id: "58371aed-250a-40c7-b883-a62c538100b1",
        submitted_at: "2026-08-07 12:05:03",
      },
    },
    ...overrides,
  };
}

export function performanceJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    risk_tier: "CAUTIOUS",
    risk_tier_updated: "2026-05-20 00:05:00",
    risk_tier_reason:
      "v10f cutover — daily_history rolled forward; new strategy starts NORMAL",
    equity: 881532.2,
    cash: 165077.0,
    cash_pct: 18.72,
    daily_pnl: 2592.2,
    daily_pnl_pct: 0.29,
    num_positions: 10,
    updated_at: "2026-08-07 12:05:05",
    daily_history: [
      { date: "2026-08-05", pnl: 708.32, pnl_pct: 0.08, equity: 888862.89 },
      { date: "2026-08-07", pnl: 2592.2, pnl_pct: 0.29, equity: 881532.2 },
    ],
    risk_lookback_sessions: 22,
    rolling_peak_equity: 1073504.44,
    rolling_drawdown_pct: -17.88,
    adaptive_rebalance_pending: frozenPlanJson(),
    ...overrides,
  };
}

export function lastRunJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: "v11_paper_production_run",
    completed_at: "2026-08-07T16:05:05.164354+00:00",
    release_sha: APPROVED_SHA,
    strategy_version: "v11-adaptive-momentum",
    status: "PASS",
    paper_only: true,
    market_entry_allowed: true,
    risk_tier: "CAUTIOUS",
    action_counts: {
      // Trimmed, then deferred the replacement buys to a later boundary — the
      // ordinary shape of a completed cycle that had sells to settle first.
      // `ADAPTIVE_PLAN_DEFERRED` is the terminal proof that it finished.
      ADAPTIVE_PLAN: 1,
      ADAPTIVE_PLAN_DEFERRED: 1,
      ADAPTIVE_TRIM: 10,
      REBALANCE_PENDING_SELLS: 1,
    },
    blocking_actions: [],
    ...overrides,
  };
}

export function positionsJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    updated_at: "2026-08-07 12:05:05",
    positions: TARGET_SYMBOLS.map((symbol) => ({
      symbol,
      qty: 100,
      avg_entry_price: 100,
      current_price: 100,
      market_value: 39668,
      unrealized_pl: 0,
      unrealized_plpc: 0,
      side: "PositionSide.LONG",
    })),
    ...overrides,
  };
}

export function preflightJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: "v11_paper_production_preflight",
    checked_at: "2026-08-07T16:04:52.779037+00:00",
    status: "PASS",
    allowed_mode: "paper",
    checks_passed: 18,
    checks_evaluated: 18,
    // The real report carries all 18 checks; the summary counts below must
    // describe exactly these, because the gate now verifies that they do.
    checks: [
      { name: "trading_mode", passed: true, detail: "paper" },
      { name: "alpaca_api_key", passed: true, detail: "present" },
      { name: "alpaca_secret_key", passed: true, detail: "present" },
      { name: "python_runtime", passed: true, detail: "3.12.11" },
      { name: "dependency_lock", passed: true, detail: "requirements.lock" },
      { name: "runtime_alpaca-py", passed: true, detail: "0.43.5" },
      { name: "runtime_numpy", passed: true, detail: "2.5.1" },
      { name: "runtime_pandas", passed: true, detail: "3.0.5" },
      {
        name: "frozen_v11_policy",
        passed: true,
        detail: "breadth-scaled top-10 policy",
      },
      {
        name: "canonical_validation_gate",
        passed: true,
        detail: "v11 fixed-strategy validation passed for paper testing",
      },
      {
        name: "strategy_identity",
        passed: true,
        detail: STRATEGY_IDENTITY,
      },
      {
        name: "ranking_universe",
        passed: true,
        detail: `540 symbols; hash=${UNIVERSE_HASH}`,
      },
      { name: "paper_endpoint", passed: true, detail: "paper-api.alpaca.markets" },
      { name: "paper_account", passed: true, detail: "ACTIVE" },
      { name: "broker_clock", passed: true, detail: "open" },
      { name: "no_short_positions", passed: true, detail: "0 shorts" },
      { name: "open_order_snapshot", passed: true, detail: "0 open orders" },
      {
        name: "fresh_risk_snapshot",
        passed: true,
        detail: "fresh broker account and rolling-history snapshot",
      },
    ],
    details: {
      account_status: "ACTIVE",
      allowed_mode: "paper-validation-eligible",
      bar_snapshot_through_date: "2026-07-10",
      market_open: true,
      open_buy_count: 0,
      open_order_count: 0,
      position_count: 10,
      risk_snapshot_reason: "fresh broker account and rolling-history snapshot",
      risk_tier: "CAUTIOUS",
      runtime_versions: {
        "alpaca-py": "0.43.5",
        numpy: "2.5.1",
        pandas: "3.0.5",
        python: "3.12.11",
      },
      short_count: 0,
      strategy_identity: STRATEGY_IDENTITY,
      universe_count: 540,
      universe_source: "validated-watchlist-fallback",
      validation_status: "PASS",
    },
    ...overrides,
  };
}

/**
 * A preflight from a run that **failed**, modelled on the real
 * `paper-diagnostics` of run 30747478499 (`workflow_dispatch`, run #2,
 * `conclusion: failure`, 2026-08-02).
 *
 * The shape is the point: the preflight ran, wrote its report, and reported
 * `FAIL` with 17 of 18 checks passing — `fresh_risk_snapshot` refused. That
 * run produced diagnostics and no runtime artifact, which is precisely the
 * case a selector filtered on `conclusion === "success"` used to skip in
 * favour of an older green report.
 */
export function failedPreflightJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = preflightJson();
  const checks = (base.checks as { name: string; passed: boolean; detail: string }[]).map(
    (check) =>
      check.name === "fresh_risk_snapshot"
        ? {
            ...check,
            passed: false,
            detail:
              "available=False, tier=NORMAL, reason=rolling broker history unavailable",
          }
        : check,
  );
  return {
    ...base,
    checked_at: "2026-08-07T16:30:00.000000+00:00",
    status: "FAIL",
    allowed_mode: "no-execution",
    checks_passed: 17,
    checks_evaluated: 18,
    checks,
    ...overrides,
  };
}

export function validationJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const segment = (
    start: string,
    end: string,
    label: string,
    metrics: Record<string, number>,
  ) => ({
    label,
    config: {
      start_date: start,
      end_date: end,
      starting_cash: 1_000_000,
      ranking_universe_sha256: UNIVERSE_HASH,
      strategy_version: "v11-adaptive-momentum",
    },
    starting_cash: 1_000_000,
    metrics,
  });

  return {
    schema_version: 1,
    kind: "v11_fixed_strategy_validation",
    generated_at: "2026-08-02T15:56:49.809791+00:00",
    strategy: {
      version: "v11-adaptive-momentum",
      identity: { schema_version: 1, algorithm: "sha256", value: STRATEGY_IDENTITY },
    },
    periods: {
      development: {
        start_date: "2022-01-04",
        end_date: "2024-12-31",
        sessions: 752,
      },
      temporal_check: {
        start_date: "2025-01-02",
        end_date: "2026-07-10",
        sessions: 380,
      },
    },
    promotion_profile: {
      promotable: true,
      starting_cash: 1_000_000,
      canonical_starting_cash: 1_000_000,
    },
    slippage_scenarios_bps: [7.0, 15.0],
    evidence: {
      schema_version: 1,
      ranking_universe_count: 540,
      ranking_universe_sha256: UNIVERSE_HASH,
      bar_snapshot_through_date: "2026-07-10",
      bar_snapshot_sha256: BAR_SNAPSHOT_SHA256,
      bar_symbols_requested: 552,
      bar_symbols_observed: 552,
    },
    warnings: [
      {
        code: "NOT_FRESH_OOS",
        message: "The later segment is a reused temporal check, not fresh OOS.",
      },
    ],
    assessment: {
      status: "PASS",
      allowed_mode: "paper-validation-eligible",
      checks_evaluated: 8,
      checks_passed: 8,
    },
    results: [
      {
        scenario: "slippage_7_bps",
        slippage_bps: 7.0,
        segments: {
          development: segment(
            "2022-01-04",
            "2024-12-31",
            "DEVELOPMENT / model-building period",
            {
              annual_return_pct: 17.1022,
              spy_annual_return_pct: 8.8198,
              excess_cagr_pct: 8.2824,
              jensen_alpha_annual_pct: 10.5896,
              sharpe_ratio: 1.0226,
              beta_to_spy: 0.3495,
              information_ratio: 0.4152,
              max_drawdown_pct: -18.6554,
              n_trading_days: 752,
            },
          ),
          temporal_check: segment(
            "2025-01-02",
            "2026-07-10",
            "REUSED TEMPORAL CHECK / not fresh OOS",
            {
              annual_return_pct: 19.9535,
              spy_annual_return_pct: 18.7328,
              excess_cagr_pct: 1.2208,
              jensen_alpha_annual_pct: 8.053,
              sharpe_ratio: 0.7789,
              beta_to_spy: 0.5683,
              information_ratio: 0.0627,
              max_drawdown_pct: -17.2217,
              n_trading_days: 380,
            },
          ),
        },
      },
    ],
    contract: {
      schema_version: 1,
      algorithm: "sha256",
      report_sha256: REPORT_SHA256,
    },
    ...overrides,
  };
}

export function tournamentJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: "v11_strategy_tournament_epoch_1",
    status: "COMPLETE",
    generated_at: "2026-08-03T15:00:00+00:00",
    research_only: true,
    production_changed: false,
    protocol: { path: "strategy/strategy_tournament_epoch_1.md" },
    cost_results: {
      "15": {
        v11_incumbent: {
          development: {
            annual_return_pct: 15.87,
            excess_cagr_pct: 7.06,
            sharpe_ratio: 0.94,
            max_drawdown_pct: -19.71,
          },
          reused_temporal: { excess_cagr_pct: -0.1 },
        },
        risk_adjusted_momentum: {
          development: {
            annual_return_pct: 12.27,
            excess_cagr_pct: 3.46,
            sharpe_ratio: 0.67,
            max_drawdown_pct: -15.43,
          },
          reused_temporal: { excess_cagr_pct: 8.02 },
        },
      },
    },
    selection: {
      decision: "RETAIN_V11",
      production_changed: false,
      statistically_eligible_challengers: [],
      shadow_challenger: null,
      candidate_gate_decisions: {
        v11_incumbent: { eligible_challenger: false },
        risk_adjusted_momentum: { eligible_challenger: false },
      },
    },
    warnings: [
      {
        code: "NO_FRESH_OOS",
        message: "2025-2026 is reused temporal evidence.",
      },
    ],
    ...overrides,
  };
}

/* --------------------------------------------- parsed, gate-ready shapes */

/**
 * A canonical report in the shape the gate consumes, already bound to the
 * runtime. Used where a test needs a *healthy* report and does not care how
 * the fields got there.
 */
export function healthyValidationInfo(): ValidationInfo {
  return {
    status: "PASS",
    allowedMode: "paper-validation-eligible",
    generatedAt: "2026-08-02T15:56:49Z",
    barBoundaryDate: "2026-07-10",
    expiresAt: "2026-09-06T15:56:49Z",
    strategyIdentityValue: STRATEGY_IDENTITY,
    rankingUniverseSha256: UNIVERSE_HASH,
    barSnapshotSha256: "b".repeat(64),
    reportSha256: "c".repeat(64),
    contractSchemaVersion: 1,
    contractAlgorithm: "sha256",
    checksEvaluated: 8,
    checksPassed: 8,
    identityMatchesRuntime: "PASS",
    universeMatchesRuntime: "PASS",
    segments: [],
    warnings: [],
  } as unknown as ValidationInfo;
}

/** The complete 18-check preflight, parsed. */
export function healthyPreflightInfo(): PreflightInfo {
  return parsePreflight(preflightJson(), null) as PreflightInfo;
}
