"use client";

import { integer } from "@/lib/status/client";
import type { StrategyStatusPayload, WorkflowAttemptInfo } from "@/lib/status/types";
import PageState from "./status/PageState";
import {
  Dash,
  Fact,
  FactList,
  Panel,
  Sha,
  StatePill,
  TableScroll,
  Timestamp,
  UnavailableBlock,
} from "./status/primitives";

/**
 * Read-only operations console.
 *
 * There is deliberately no execute, cancel, buy, sell, release-approval or
 * emergency-trade control here. Trading actions belong to the guarded GitHub
 * Actions workflow, never to a web session.
 */
export default function OperationsClient() {
  return (
    <PageState>
      {(payload) => (
        <div className="space-y-5">
          <IdentityPanel payload={payload} />
          <SchedulerPanel payload={payload} />
          <PreflightPanel payload={payload} />
          <ExecutionPanel payload={payload} />
          <ReadOnlyNotice />
        </div>
      )}
    </PageState>
  );
}

function IdentityPanel({ payload }: { payload: StrategyStatusPayload }) {
  const web = payload.web.data;
  const release = payload.release.data;
  const validation = payload.validation.data;
  return (
    <Panel
      title="Release identity and gates"
      subtitle="Four independent SHAs. A push to main is not a trading release."
      provenance={payload.release.provenance}
    >
      <div className="grid gap-x-8 md:grid-cols-2">
        <FactList>
          <Fact label="Dashboard build SHA" mono>
            <Sha value={web?.dashboardBuildSha} />
          </Fact>
          <Fact label={`Repository / research SHA (${release?.repositoryRef ?? "main"})`} mono>
            <Sha value={release?.repositoryRefSha} />
          </Fact>
          <Fact label="Approved paper release SHA" mono>
            <Sha value={release?.approvedPaperReleaseSha} />
          </Fact>
          <Fact label="Approved SHA source">
            {release?.approvedShaSource ?? <Dash />}
          </Fact>
          <Fact label="Latest scheduled trigger SHA" mono>
            <Sha value={payload.operations.data?.latestAttempt?.triggerSha} />
          </Fact>
        </FactList>
        <FactList>
          <Fact label="Release gate for the approved SHA">
            <span className="inline-flex items-center gap-2">
              <StatePill size="xs" state={release?.releaseGate ?? "UNAVAILABLE"} />
              {release?.releaseGateRunUrl && (
                <a
                  href={release.releaseGateRunUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-blue hover:underline"
                >
                  view run
                </a>
              )}
            </span>
          </Fact>
          <Fact label="Validation gate (effective)">
            <span className="inline-flex items-center gap-2">
              <StatePill size="xs" state={payload.validationGate.effective} />
              <span className="text-[10px] text-muted">
                report {payload.validationGate.reportAssessment}
              </span>
            </span>
          </Fact>
          {payload.validationGate.details.length > 0 && (
            <Fact label="Why the gate is not effective">
              {payload.validationGate.details.join(" ")}
            </Fact>
          )}
          <Fact label="Validation expiry">
            {validation?.expiresAt?.slice(0, 10) ?? <Dash />}
          </Fact>
          <Fact label="Execution mode">
            <StatePill size="xs" state="PASS" label="PAPER ONLY" />
          </Fact>
          <Fact label="Dashboard build equals approved release">
            {release?.dashboardMatchesApprovedRelease === null ||
            release?.dashboardMatchesApprovedRelease === undefined ? (
              <Dash />
            ) : (
              <StatePill
                size="xs"
                state="NOT_APPLICABLE"
                label={
                  release.dashboardMatchesApprovedRelease
                    ? "SAME COMMIT"
                    : "DIFFERENT COMMIT (EXPECTED)"
                }
                title="The dashboard and the paper executor are independent deployables. A difference is normal and is not a failure."
              />
            )}
          </Fact>
        </FactList>
      </div>
    </Panel>
  );
}

function AttemptRow({ attempt }: { attempt: WorkflowAttemptInfo }) {
  const state =
    attempt.status !== "completed"
      ? "PENDING"
      : attempt.conclusion === "success"
        ? "PASS"
        : attempt.infrastructureFailure
          ? "WARN"
          : "FAIL";
  return (
    <tr>
      <th scope="row" className="num font-semibold">
        #{attempt.runNumber}
      </th>
      <td>
        <StatePill
          size="xs"
          state={state}
          label={
            attempt.status !== "completed"
              ? "RUNNING"
              : (attempt.conclusion ?? "unknown").toUpperCase()
          }
        />
      </td>
      <td>{attempt.event}</td>
      <td>
        {attempt.failureKind === "infrastructure"
          ? "GitHub infrastructure — no job step ran"
          : attempt.failureKind === "strategy-or-broker"
            ? "Failed after the job started"
            : "—"}
      </td>
      <td className="font-mono text-[11px]">
        <Sha value={attempt.triggerSha} />
      </td>
      <td>
        <Timestamp iso={attempt.completedAt ?? attempt.startedAt} />
      </td>
      <td>
        <a
          href={attempt.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-blue hover:underline"
        >
          run
        </a>
      </td>
    </tr>
  );
}

function SchedulerPanel({ payload }: { payload: StrategyStatusPayload }) {
  const operations = payload.operations.data;
  return (
    <Panel
      title="Scheduler"
      subtitle="The latest attempt and the last successful cycle are separate facts."
      actions={
        operations && (
          <a
            href={operations.workflowUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-blue hover:underline"
          >
            Workflow history →
          </a>
        )
      }
      provenance={payload.operations.provenance}
    >
      {operations?.latestAttempt || operations?.lastSuccessfulRun ? (
        <TableScroll>
          <table className="data">
            <caption className="sr-only">
              Latest paper-production attempt and last successful cycle
            </caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Outcome</th>
                <th scope="col">Trigger</th>
                <th scope="col">Failure kind</th>
                <th scope="col">Trigger SHA</th>
                <th scope="col">When</th>
                <th scope="col">Link</th>
              </tr>
            </thead>
            <tbody>
              {operations.latestAttempt && (
                <AttemptRow attempt={operations.latestAttempt} />
              )}
              {operations.lastSuccessfulRun &&
                operations.lastSuccessfulRun.runId !==
                  operations.latestAttempt?.runId && (
                  <AttemptRow attempt={operations.lastSuccessfulRun} />
                )}
            </tbody>
          </table>
        </TableScroll>
      ) : (
        <UnavailableBlock
          state={payload.operations.provenance.freshness}
          title="Workflow history unavailable"
          detail={payload.operations.provenance.detail}
          source={payload.operations.provenance.source}
        />
      )}
      {operations?.latestAttempt?.infrastructureFailure && (
        <p
          className="mt-3 rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--accent-amber)",
            background: "var(--tint-amber)",
          }}
        >
          The latest attempt failed inside GitHub&apos;s infrastructure before any
          job step ran. No strategy, preflight or broker execution happened in
          that attempt, and the last successful executor snapshot above is
          unaffected.
        </p>
      )}
    </Panel>
  );
}

function PreflightPanel({ payload }: { payload: StrategyStatusPayload }) {
  const preflight = payload.preflight.data;
  return (
    <Panel
      title="Latest completed preflight"
      subtitle="Read-only broker and release safety checks"
      provenance={payload.preflight.provenance}
    >
      {preflight ? (
        <>
          <div className="grid gap-x-8 md:grid-cols-2 mb-4">
            <FactList>
              <Fact label="Result">
                <span className="inline-flex items-center gap-2">
                  <StatePill size="xs" state={preflight.status} />
                  <span className="numeric">
                    {preflight.checksPassed}/{preflight.checksEvaluated}
                  </span>
                </span>
              </Fact>
              <Fact label="Allowed mode">{preflight.allowedMode ?? <Dash />}</Fact>
              <Fact label="Broker account status">
                {preflight.accountStatus ?? <Dash />}
              </Fact>
              <Fact label="Market open at check">
                {preflight.marketOpen === null ? (
                  <Dash />
                ) : (
                  <StatePill
                    size="xs"
                    state={preflight.marketOpen ? "PASS" : "NOT_APPLICABLE"}
                    label={preflight.marketOpen ? "OPEN" : "CLOSED"}
                  />
                )}
              </Fact>
            </FactList>
            <FactList>
              <Fact label="Positions / shorts">
                {integer(preflight.positionCount)} / {integer(preflight.shortCount)}
              </Fact>
              <Fact label="Open orders / open buys">
                {integer(preflight.openOrderCount)} /{" "}
                {integer(preflight.openBuyCount)}
              </Fact>
              <Fact label="Risk snapshot">
                {preflight.riskTier ?? <Dash />}
                {preflight.riskSnapshotReason
                  ? ` — ${preflight.riskSnapshotReason}`
                  : ""}
              </Fact>
              <Fact label="Runtime">
                {preflight.runtimeVersions
                  ? Object.entries(preflight.runtimeVersions)
                      .map(([name, version]) => `${name} ${version}`)
                      .join(" · ")
                  : "—"}
              </Fact>
            </FactList>
          </div>
          <TableScroll>
            <table className="data">
              <caption className="sr-only">Preflight checks</caption>
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Result</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {preflight.checks.map((check) => (
                  <tr key={check.name}>
                    <th scope="row" className="text-left font-mono text-[11px]">
                      {check.name}
                    </th>
                    <td>
                      <StatePill
                        size="xs"
                        state={check.passed ? "PASS" : "FAIL"}
                      />
                    </td>
                    <td className="whitespace-normal break-words">
                      {check.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      ) : (
        <UnavailableBlock
          state={payload.preflight.provenance.freshness}
          title="Preflight report unavailable"
          detail={payload.preflight.provenance.detail}
          source={payload.preflight.provenance.source}
        />
      )}
    </Panel>
  );
}

function ExecutionPanel({ payload }: { payload: StrategyStatusPayload }) {
  const execution = payload.execution.data;
  const strategy = payload.strategy.data;
  const convergence = payload.convergence.data;
  return (
    <Panel
      title="Last successful executor cycle"
      subtitle="Sanitized action counts. Submission is intent, never proof of a fill."
      actions={
        execution?.runUrl && (
          <a
            href={execution.runUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-blue hover:underline"
          >
            Actions run →
          </a>
        )
      }
      provenance={payload.execution.provenance}
    >
      {execution ? (
        <>
          <div className="grid gap-x-8 md:grid-cols-2">
            <FactList>
              <Fact label="Result">
                <StatePill size="xs" state={execution.status} />
              </Fact>
              <Fact label="Completed">
                <Timestamp iso={execution.completedAt} />
              </Fact>
              <Fact label="Release SHA of the cycle" mono>
                <Sha value={execution.releaseSha} />
              </Fact>
              <Fact label="Paper only">
                <StatePill
                  size="xs"
                  state={execution.paperOnly ? "PASS" : "FAIL"}
                  label={execution.paperOnly ? "YES" : "NO"}
                />
              </Fact>
            </FactList>
            <FactList>
              <Fact label="Market entry allowed">
                {execution.marketEntryAllowed === null ? (
                  <Dash />
                ) : (
                  <StatePill
                    size="xs"
                    state={
                      execution.marketEntryAllowed ? "PASS" : "NOT_APPLICABLE"
                    }
                    label={execution.marketEntryAllowed ? "ALLOWED" : "BLOCKED"}
                  />
                )}
              </Fact>
              <Fact label="Risk tier captured by the cycle">
                {execution.riskTier ?? <Dash />}
              </Fact>
              <Fact label="Frozen plan" mono>
                {strategy?.plan?.planId ?? <Dash />}
              </Fact>
              <Fact label="Convergence">
                {convergence
                  ? `${convergence.convergedCount}/${convergence.targetCount} settled · ${convergence.pendingCount} pending`
                  : "NOT APPLICABLE for the selected account"}
              </Fact>
              <Fact label="Blocking reason">
                {execution.blockingReason ?? "none recorded"}
              </Fact>
            </FactList>
          </div>

          <h3 className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-secondary">
            Action counts
          </h3>
          {Object.keys(execution.actionCounts).length === 0 ? (
            <p className="text-xs text-secondary">
              No action records were emitted by this cycle.
            </p>
          ) : (
            <TableScroll>
              <table className="data">
                <caption className="sr-only">Executor action counts</caption>
                <thead>
                  <tr>
                    <th scope="col">Action</th>
                    <th scope="col" className="num">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(execution.actionCounts)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([action, count]) => (
                      <tr key={action}>
                        <th scope="row" className="text-left font-mono text-[11px]">
                          {action}
                        </th>
                        <td className="num">{count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </>
      ) : (
        <UnavailableBlock
          state={payload.execution.provenance.freshness}
          title="Executor run record unavailable"
          detail={payload.execution.provenance.detail}
          source={payload.execution.provenance.source}
        />
      )}
    </Panel>
  );
}

function ReadOnlyNotice() {
  return (
    <Panel title="Why there are no controls here">
      <p className="text-xs text-secondary max-w-prose">
        Execution is owned by the guarded <code>V11 Paper Production</code>{" "}
        workflow, which checks out only the approved release SHA, requires a
        green release gate for that exact commit, and runs a preflight before it
        touches the broker. Adding an execute, cancel or approve control to a
        web session would bypass those gates, so this page is read-only by
        design. Emergency procedures live in{" "}
        <code>strategy/PRODUCTION_RUNBOOK.md</code>.
      </p>
    </Panel>
  );
}
