"use client";

import { decimal, integer, money, percent, points } from "@/lib/status/client";
import type { StrategyStatusPayload } from "@/lib/status/types";
import PageState from "./status/PageState";
import { ComparisonBars, Disclosure, SERIES, SignedBars } from "./status/charts";
import {
  Dash,
  Fact,
  FactList,
  Panel,
  Sha,
  StatePill,
  TableScroll,
  UnavailableBlock,
} from "./status/primitives";

/**
 * Promotion evidence and cross-strategy research.
 *
 * The canonical validator and the epoch-1 tournament are two different
 * controlled experiments with different runners, cost grids and periods. Their
 * V11 numbers differ slightly and are deliberately never merged into one
 * "alpha" figure.
 */
export default function ValidationResearchClient() {
  return (
    <PageState>
      {(payload) => (
        <div className="space-y-5">
          <CanonicalPanel payload={payload} />
          <MetricsPanel payload={payload} />
          <LimitationsPanel payload={payload} />
          <TournamentPanel payload={payload} />
        </div>
      )}
    </PageState>
  );
}

function CanonicalPanel({ payload }: { payload: StrategyStatusPayload }) {
  const validation = payload.validation.data;
  const gate = payload.validationGate;
  return (
    <Panel
      title="Canonical V11 validation"
      subtitle="Fixed checked-in parameters; no optimizer, no sweep"
      provenance={payload.validation.provenance}
    >
      {validation ? (
        <div className="grid gap-x-8 md:grid-cols-2">
          <FactList>
            <Fact label="Stored report assessment">
              <span className="inline-flex items-center gap-2">
                <StatePill size="xs" state={gate.reportAssessment} />
                {validation.checksPassed !== null && (
                  <span className="numeric">
                    {validation.checksPassed}/{validation.checksEvaluated} checks
                  </span>
                )}
              </span>
            </Fact>
            <Fact label="Effective paper-buy gate">
              <StatePill size="xs" state={gate.effective} />
            </Fact>
            <Fact label="Allowed mode">{validation.allowedMode ?? <Dash />}</Fact>
            <Fact label="Generated">
              {validation.generatedAt?.replace("T", " ").slice(0, 19) ?? <Dash />}
            </Fact>
            <Fact label="Adjusted-bar boundary">
              {validation.barBoundaryDate ?? <Dash />}
            </Fact>
            <Fact label="Expires">
              <span className="inline-flex items-center gap-2">
                {validation.expiresAt?.slice(0, 10) ?? <Dash />}
                {validation.expiryBasis && (
                  <span className="text-[10px] text-muted">
                    ({validation.expiryBasis} is the binding constraint)
                  </span>
                )}
                {payload.validation.provenance.freshness === "EXPIRED" && (
                  <StatePill size="xs" state="EXPIRED" />
                )}
              </span>
            </Fact>
            <Fact label="Starting capital">
              {money(validation.startingCapital)}
            </Fact>
          </FactList>
          <FactList>
            <Fact label="Strategy identity" mono>
              <Sha value={validation.strategyIdentityValue} />
            </Fact>
            <Fact label="Identity matches running code">
              <StatePill size="xs" state={validation.identityMatchesRuntime} />
            </Fact>
            <Fact label="Ranking-universe hash" mono>
              <Sha value={validation.rankingUniverseSha256} />
            </Fact>
            <Fact label="Universe matches running universe">
              <StatePill size="xs" state={validation.universeMatchesRuntime} />
            </Fact>
            <Fact label="Ranking symbols">
              {integer(validation.rankingUniverseCount)}
            </Fact>
            <Fact label="Report digest" mono>
              <Sha value={validation.reportSha256} />
            </Fact>
          </FactList>
        </div>
      ) : (
        <UnavailableBlock
          state={payload.validation.provenance.freshness}
          title="Canonical validation report unavailable"
          detail={payload.validation.provenance.detail}
          source={payload.validation.provenance.source}
        />
      )}
      {gate.details.length > 0 && (
        <ul className="mt-4 space-y-1 text-xs list-disc pl-5" style={{ color: "var(--accent-amber)" }}>
          {gate.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-secondary max-w-prose">
        The stored assessment is a historical conclusion. Only the{" "}
        <strong>effective</strong> gate above may authorize a paper buy, and it
        additionally requires unexpired evidence, a matching strategy identity
        and ranking universe, and a known approved release. A{" "}
        <strong>PASS</strong> authorizes forward <em>paper</em> validation of
        the unchanged code against this exact ranking universe. It does not
        authorize live money and is not a claim of future alpha. The report
        digest is tamper-evident, not a keyed authorization signature.
      </p>
    </Panel>
  );
}

function MetricsPanel({ payload }: { payload: StrategyStatusPayload }) {
  const validation = payload.validation.data;
  const metrics = validation?.metrics ?? [];
  if (!validation || metrics.length === 0) {
    return null;
  }
  const development = metrics.filter((row) => row.segment === "development");
  const reused = metrics.filter((row) => row.segment === "temporal_check");

  return (
    <Panel
      title="Historical diagnostic metrics"
      subtitle="Development and reused temporal check reported separately, per cost scenario"
      provenance={payload.validation.provenance}
    >
      <MetricsTable
        heading={
          development[0]?.segmentLabel ?? "DEVELOPMENT / model-building period"
        }
        rows={development}
      />
      <div className="h-5" />
      <MetricsTable
        heading={
          reused[0]?.segmentLabel ?? "REUSED TEMPORAL CHECK / not fresh OOS"
        }
        rows={reused}
        warn
      />
    </Panel>
  );
}

function MetricsTable({
  heading,
  rows,
  warn = false,
}: {
  heading: string;
  rows: StrategyStatusPayload["validation"]["data"] extends null
    ? never
    : NonNullable<StrategyStatusPayload["validation"]["data"]>["metrics"];
  warn?: boolean;
}) {
  if (rows.length === 0) return null;
  // V11 vs SPY CAGR, one grouped pair per cost row — only real numbers, never a
  // fabricated 0. A row with a missing V11 or SPY figure is left out entirely.
  const sorted = [...rows].sort((a, b) => a.slippageBps - b.slippageBps);
  const cagrData = sorted
    .filter((r) => r.cagrPct !== null && r.spyCagrPct !== null)
    .map((r) => ({
      label: `${r.slippageBps} bps`,
      v11: r.cagrPct as number,
      spy: r.spyCagrPct as number,
    }));
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary mb-2 flex flex-wrap items-center gap-2">
        {heading}
        {warn && (
          <StatePill size="xs" state="WARN" label="NOT FRESH OOS" />
        )}
        <span className="font-normal normal-case text-muted">
          {rows[0].startDate} → {rows[0].endDate} · {rows[0].sessions} sessions
        </span>
      </h3>
      {cagrData.length > 0 && (
        <div className="mb-3">
          <ComparisonBars
            title="V11 vs SPY — CAGR"
            data={cagrData}
            series={[
              { key: "v11", name: "V11", color: SERIES.primary },
              { key: "spy", name: "SPY", color: SERIES.benchmark },
            ]}
            valueFormatter={(v) => percent(Number(v))}
            height={200}
          />
        </div>
      )}
      <TableScroll>
        <table className="data">
          <caption className="sr-only">{heading} metrics by cost scenario</caption>
          <thead>
            <tr>
              <th scope="col" className="num">Cost / fill</th>
              <th scope="col" className="num">V11 CAGR</th>
              <th scope="col" className="num">SPY CAGR</th>
              <th scope="col" className="num">Excess CAGR</th>
              <th scope="col" className="num">Jensen alpha</th>
              <th scope="col" className="num">Beta</th>
              <th scope="col" className="num">Sharpe</th>
              <th scope="col" className="num">Info ratio</th>
              <th scope="col" className="num">Max drawdown</th>
            </tr>
          </thead>
          <tbody>
            {[...rows]
              .sort((a, b) => a.slippageBps - b.slippageBps)
              .map((row) => (
                <tr key={`${row.segment}-${row.slippageBps}`}>
                  <th scope="row" className="num font-semibold">
                    {row.slippageBps} bps
                  </th>
                  <td className="num">{percent(row.cagrPct)}</td>
                  <td className="num">{percent(row.spyCagrPct)}</td>
                  <td
                    className="num"
                    style={{
                      color:
                        (row.excessCagrPct ?? 0) > 0
                          ? "var(--accent-green)"
                          : "var(--accent-red)",
                    }}
                  >
                    {points(row.excessCagrPct)}
                  </td>
                  <td className="num">{percent(row.jensenAlphaPct, 2, true)}</td>
                  <td className="num">{decimal(row.betaToSpy)}</td>
                  <td className="num">{decimal(row.sharpe)}</td>
                  <td className="num">{decimal(row.informationRatio)}</td>
                  <td className="num" style={{ color: "var(--accent-red)" }}>
                    {percent(row.maxDrawdownPct)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}

function LimitationsPanel({ payload }: { payload: StrategyStatusPayload }) {
  const warnings = payload.validation.data?.warnings ?? [];
  return (
    <Panel title="Limitations that must accompany these metrics">
      <p className="text-xs text-secondary max-w-prose">
        These are backtest diagnostics with survivorship bias and a reused
        temporal check — <strong>not</strong> fresh out-of-sample evidence and not
        a promise of alpha. Only frozen-rule forward paper performance settles it.
      </p>
      <Disclosure summary="Read the full limitations">
      <ul className="space-y-2 text-xs text-secondary max-w-prose list-disc pl-5">
        <li>
          The later 2025–2026 interval is a{" "}
          <strong>reused temporal check</strong>, already inspected during
          development. A positive result there is not fresh out-of-sample
          evidence.
        </li>
        <li>
          The ranking universe is a current/fallback list, not point-in-time
          membership with complete delisting returns — historical runs carry
          survivorship and selection bias.
        </li>
        <li>
          Jensen alpha is a SPY/BIL CAPM statistic and partly reflects lower SPY
          beta; it is not a promise of economic profit. Raw excess CAGR at the
          higher cost assumption is economically thin.
        </li>
        <li>
          Fixed slippage scenarios do not model every spread, market impact,
          queue position, partial fill, rejection or outage.
        </li>
        <li>
          The only evidence that can settle the question is frozen-rule forward
          paper performance across several monthly rebalances, including at
          least one weak-market interval.
        </li>
        {warnings.map((warning) => (
          <li key={warning.code}>
            <code className="font-mono text-[11px]">{warning.code}</code> —{" "}
            {warning.message}
          </li>
        ))}
      </ul>
      </Disclosure>
    </Panel>
  );
}

function CandidateExcessChart({
  candidates,
}: {
  candidates: NonNullable<StrategyStatusPayload["tournament"]["data"]>["candidates"];
}) {
  // Development excess CAGR over SPY, one bar per candidate — real numbers only.
  const data = candidates
    .filter((c) => c.developmentExcessCagrPct !== null)
    .map((c) => ({
      name: c.name,
      value: c.developmentExcessCagrPct as number,
    }));
  if (data.length === 0) return null;
  return (
    <div className="mb-3">
      <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">
        Development excess CAGR vs SPY, per candidate
      </p>
      <SignedBars
        data={data}
        valueFormatter={(v) => points(v)}
        labelWidth={170}
      />
    </div>
  );
}

function TournamentPanel({ payload }: { payload: StrategyStatusPayload }) {
  const tournament = payload.tournament.data;
  return (
    <Panel
      title="Strategy tournament — epoch 1"
      subtitle="A separate, pre-registered research experiment. Different runner, different cost grid, different folds."
      provenance={payload.tournament.provenance}
    >
      {tournament ? (
        <>
          <div className="grid gap-x-8 md:grid-cols-2">
            <FactList>
              <Fact label="Status">{tournament.status}</Fact>
              <Fact label="Decision">
                <StatePill
                  size="xs"
                  state={tournament.decision === "RETAIN_V11" ? "PASS" : "WARN"}
                  label={tournament.decision}
                />
              </Fact>
              <Fact label="Production changed">
                <StatePill
                  size="xs"
                  state={tournament.productionChanged ? "WARN" : "PASS"}
                  label={tournament.productionChanged ? "YES" : "NO"}
                />
              </Fact>
            </FactList>
            <FactList>
              <Fact label="Statistically eligible challengers">
                {integer(tournament.eligibleChallengerCount)}
              </Fact>
              <Fact label="Shadow challenger">
                {tournament.shadowChallenger ?? "none selected"}
              </Fact>
              <Fact label="Protocol">{tournament.protocolPath}</Fact>
            </FactList>
          </div>

          <h3 className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-secondary">
            Candidates at the primary {tournament.primaryCostBps} bps assumption
          </h3>
          <CandidateExcessChart candidates={tournament.candidates} />
          <TableScroll>
            <table className="data">
              <caption className="sr-only">
                Epoch-1 tournament candidates
              </caption>
              <thead>
                <tr>
                  <th scope="col">Candidate</th>
                  <th scope="col" className="num">Dev CAGR</th>
                  <th scope="col" className="num">Dev excess</th>
                  <th scope="col" className="num">Dev Sharpe</th>
                  <th scope="col" className="num">Dev drawdown</th>
                  <th scope="col" className="num">Reused excess</th>
                  <th scope="col">Gate</th>
                </tr>
              </thead>
              <tbody>
                {tournament.candidates.map((candidate) => (
                  <tr key={candidate.name}>
                    <th scope="row" className="text-left font-mono">
                      {candidate.name}
                      {candidate.isIncumbent && (
                        <span className="ml-2 text-[10px] text-muted">
                          incumbent
                        </span>
                      )}
                    </th>
                    <td className="num">{percent(candidate.developmentCagrPct)}</td>
                    <td className="num">
                      {points(candidate.developmentExcessCagrPct)}
                    </td>
                    <td className="num">{decimal(candidate.developmentSharpe)}</td>
                    <td className="num">
                      {percent(candidate.developmentMaxDrawdownPct)}
                    </td>
                    <td className="num">{points(candidate.reusedExcessCagrPct)}</td>
                    <td>
                      <StatePill
                        size="xs"
                        state={
                          candidate.isIncumbent
                            ? "NOT_APPLICABLE"
                            : candidate.eligibleChallenger
                              ? "PASS"
                              : "FAIL"
                        }
                        label={
                          candidate.isIncumbent
                            ? "BASELINE"
                            : candidate.eligibleChallenger
                              ? "ELIGIBLE"
                              : "FAIL"
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>

          <p className="mt-4 text-xs text-secondary max-w-prose">
            No challenger passed all return, drawdown, cost, delay, capacity,
            stability and multiple-testing gates, so{" "}
            <strong>production did not change</strong>.
          </p>
          <Disclosure summary="Tournament caveats">
            <ul className="space-y-2 text-xs text-secondary max-w-prose list-disc pl-5">
              <li>
                These metrics come from the tournament runner, not the canonical
                validator. The two experiments report slightly different V11
                reused-period numbers and must not be combined.
              </li>
              {tournament.warnings.map((warning) => (
                <li key={warning.code}>
                  <code className="font-mono text-[11px]">{warning.code}</code> —{" "}
                  {warning.message}
                </li>
              ))}
            </ul>
          </Disclosure>
        </>
      ) : (
        <UnavailableBlock
          state={payload.tournament.provenance.freshness}
          title="Tournament evidence unavailable"
          detail={payload.tournament.provenance.detail}
          source={payload.tournament.provenance.source}
        />
      )}
    </Panel>
  );
}
