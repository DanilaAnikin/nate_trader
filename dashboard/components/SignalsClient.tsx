"use client";

import { integer, percent } from "@/lib/status/client";
import type { StrategyStatusPayload } from "@/lib/status/types";
import PageState from "./status/PageState";
import {
  Dash,
  Fact,
  FactList,
  Panel,
  StatePill,
  TableScroll,
  UnavailableBlock,
} from "./status/primitives";

/**
 * V11 signals and universe.
 *
 * The 12-1 ranking is never recomputed here. Everything shown is a sanitized
 * diagnostic the production runner persisted; anything the runner does not
 * persist is reported as UNAVAILABLE instead of being reconstructed in
 * TypeScript from a different data source.
 */
const FUNNEL_STAGES = [
  {
    key: "history",
    label: "Complete 253-session history, no >10-day gap",
  },
  { key: "price", label: "Last close ≥ $10" },
  { key: "liquidity", label: "Median 60-session dollar volume ≥ $25m" },
  { key: "momentum", label: "12-1 momentum > 0" },
  { key: "trend", label: "Close above SMA200" },
  { key: "volatility", label: "Annualized 63-session volatility ≤ 80%" },
  { key: "sector", label: "Known or inferable sector" },
] as const;

export default function SignalsClient() {
  return (
    <PageState>
      {(payload) => (
        <div className="space-y-5">
          <UniversePanel payload={payload} />
          <FunnelPanel payload={payload} />
          <BreadthPanel payload={payload} />
          <BasketPanel payload={payload} />
          <ArchiveNote />
        </div>
      )}
    </PageState>
  );
}

function UniversePanel({ payload }: { payload: StrategyStatusPayload }) {
  const universe = payload.universe.data;
  return (
    <Panel
      title="Ranking universe"
      subtitle="The exact symbol set the production executor ranked"
      provenance={payload.universe.provenance}
    >
      {universe ? (
        <div className="grid gap-x-8 md:grid-cols-2">
          <FactList>
            <Fact label="Source">{universe.source}</Fact>
            <Fact label="Cache state">
              {universe.cacheState === "alpaca-cache" ? (
                <StatePill size="xs" state="CURRENT" label="ALPACA CACHE" />
              ) : universe.cacheState === "validated-watchlist-fallback" ? (
                <StatePill
                  size="xs"
                  state="NOT_APPLICABLE"
                  label="WATCHLIST FALLBACK"
                  title="state/universe.json is absent, so the validated local watchlist fallback is in force. This is not the broad dynamic Alpaca universe."
                />
              ) : (
                <Dash />
              )}
            </Fact>
            <Fact label="Symbol count">{integer(universe.symbolCount)}</Fact>
          </FactList>
          <FactList>
            <Fact label="Ranking-universe SHA-256" mono>
              {universe.rankingUniverseSha256 ?? <Dash />}
            </Fact>
            <Fact label="Eligible at signal date">
              {integer(universe.eligibleCount)}
            </Fact>
            <Fact label="Selected targets">
              {integer(universe.selectedCount)}
            </Fact>
          </FactList>
        </div>
      ) : (
        <UnavailableBlock
          state={payload.universe.provenance.freshness}
          title="Universe diagnostics unavailable"
          detail={payload.universe.provenance.detail}
          source={payload.universe.provenance.source}
        />
      )}
      {universe?.cacheState === "validated-watchlist-fallback" && (
        <p className="mt-4 text-xs text-secondary max-w-prose">
          The broad dynamically discovered common-stock/ADR universe has not
          been downloaded and historically validated as one frozen ranking set.
          A refresh changes the universe hash and requires a full adjusted
          rebuild plus a new canonical validation before another paper buy.
        </p>
      )}
    </Panel>
  );
}

function FunnelPanel({ payload }: { payload: StrategyStatusPayload }) {
  const universe = payload.universe.data;
  const plan = payload.strategy.data?.plan ?? null;
  return (
    <Panel
      title="Eligibility funnel"
      subtitle={
        plan?.signalDate
          ? `Completed signal session D = ${plan.signalDate}`
          : "Completed signal session unknown"
      }
      provenance={payload.universe.provenance}
    >
      <div className="flex flex-wrap items-stretch gap-3 mb-5">
        <FunnelStep
          label="Ranking universe"
          value={integer(universe?.symbolCount)}
        />
        <FunnelArrow />
        <FunnelStep
          label="Eligible at D"
          value={integer(universe?.eligibleCount)}
        />
        <FunnelArrow />
        <FunnelStep
          label="Selected targets"
          value={integer(universe?.selectedCount)}
        />
      </div>

      <TableScroll>
        <table className="data">
          <caption className="sr-only">
            Per-filter eligibility funnel and its availability
          </caption>
          <thead>
            <tr>
              <th scope="col">Filter stage</th>
              <th scope="col" className="num">Symbols passing</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {FUNNEL_STAGES.map((stage) => (
              <tr key={stage.key}>
                <th scope="row" className="text-left font-normal">
                  {stage.label}
                </th>
                <td className="num">
                  <Dash />
                </td>
                <td>
                  <StatePill size="xs" state="UNAVAILABLE" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <p className="mt-3 text-xs text-secondary max-w-prose">
        The production runner records only the aggregate eligible count, not
        the per-filter census or the 12-1 / 6-1 rank table. Reimplementing the
        V11 ranking in the browser would create a second, unvalidated strategy,
        so these rows stay <strong>UNAVAILABLE</strong> until the runner exports
        a sanitized ranking diagnostic.
      </p>
    </Panel>
  );
}

function FunnelStep({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 min-w-[9rem] rounded-md border border-border bg-surface px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold numeric">{value}</p>
    </div>
  );
}

function FunnelArrow() {
  return (
    <div
      aria-hidden="true"
      className="hidden sm:flex items-center text-muted text-lg"
    >
      →
    </div>
  );
}

function BreadthPanel({ payload }: { payload: StrategyStatusPayload }) {
  const strategy = payload.strategy.data;
  return (
    <Panel
      title="Breadth and rank diagnostics"
      provenance={payload.strategy.provenance}
    >
      <div className="grid gap-x-8 md:grid-cols-2">
        <FactList>
          <Fact label="Breadth numerator / denominator">
            <StatePill size="xs" state="UNAVAILABLE" />
          </Fact>
          <Fact label="Breadth percentage">
            <StatePill size="xs" state="UNAVAILABLE" />
          </Fact>
          <Fact label="Breadth tier multiplier">
            <StatePill size="xs" state="UNAVAILABLE" />
          </Fact>
        </FactList>
        <FactList>
          <Fact label="12-1 rank table">
            <StatePill size="xs" state="UNAVAILABLE" />
          </Fact>
          <Fact label="6-1 tie-break values">
            <StatePill size="xs" state="UNAVAILABLE" />
          </Fact>
          <Fact label="SPY gate outcome (recorded)">
            {strategy?.marketGate ? (
              <StatePill
                size="xs"
                state={strategy.marketGate === "RISK_ON" ? "PASS" : "FAIL"}
                label={strategy.marketGate}
              />
            ) : (
              <StatePill size="xs" state="UNAVAILABLE" />
            )}
          </Fact>
        </FactList>
      </div>
      <p className="mt-3 text-xs text-secondary max-w-prose">
        Breadth scales gross exposure only; it never reranks names and cannot
        bypass the SPY gate, the portfolio-damage tier, the 9% single-name cap
        or the 20% sector cap.
      </p>
    </Panel>
  );
}

function BasketPanel({ payload }: { payload: StrategyStatusPayload }) {
  const plan = payload.strategy.data?.plan ?? null;
  const bySector = new Map<string, number>();
  for (const target of plan?.targets ?? []) {
    bySector.set(
      target.sector,
      (bySector.get(target.sector) ?? 0) + target.weightPct,
    );
  }

  return (
    <Panel
      title="Selected target basket"
      subtitle={
        plan
          ? `Plan ${plan.planId} · ${plan.targets.length} name(s) · gross ${percent(plan.targetGrossPct)}`
          : undefined
      }
      provenance={payload.strategy.provenance}
    >
      {!plan ? (
        <UnavailableBlock
          state={payload.strategy.provenance.freshness}
          title="No frozen plan available"
          detail={payload.strategy.provenance.detail}
          source={payload.strategy.provenance.source}
        />
      ) : plan.targets.length === 0 ? (
        <UnavailableBlock
          state="NOT_APPLICABLE"
          title={
            plan.riskOff
              ? "Zero target — SPY risk-off"
              : "Zero target recorded by the runner"
          }
          detail="An empty basket here is a recorded strategy decision, not missing data."
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
          <TableScroll>
            <table className="data">
              <caption className="sr-only">Target weights by symbol</caption>
              <thead>
                <tr>
                  <th scope="col">Symbol</th>
                  <th scope="col">Sector</th>
                  <th scope="col" className="num">Target weight</th>
                </tr>
              </thead>
              <tbody>
                {plan.targets.map((target) => (
                  <tr key={target.symbol}>
                    <th scope="row" className="font-mono font-semibold text-left">
                      {target.symbol}
                    </th>
                    <td>{target.sector}</td>
                    <td className="num">{percent(target.weightPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <TableScroll>
            <table className="data">
              <caption className="sr-only">Target weight by sector</caption>
              <thead>
                <tr>
                  <th scope="col">Sector</th>
                  <th scope="col" className="num">Weight</th>
                </tr>
              </thead>
              <tbody>
                {[...bySector.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([sector, weight]) => (
                    <tr key={sector}>
                      <th scope="row" className="text-left font-normal">
                        {sector}
                      </th>
                      <td className="num">{percent(weight)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </TableScroll>
        </div>
      )}
    </Panel>
  );
}

function ArchiveNote() {
  return (
    <Panel title="Retired V10 screener signals">
      <p className="text-xs text-secondary max-w-prose">
        The legacy confidence score with a 65 threshold, most-active lists, top
        movers, trending tickers and news/AI sentiment are{" "}
        <strong>not used by V11</strong> and no longer appear in the trading UI.
        They were part of the retired V10 process; V11 authorizes a position
        only through 12-1 momentum ranking, the eligibility filters, the SPY
        trend gate, breadth scaling and the portfolio-damage tier.
      </p>
    </Panel>
  );
}
