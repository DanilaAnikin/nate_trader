"use client";

import { absoluteTimestamps, systemIndicators } from "@/lib/status/client";
import { formatAge } from "@/lib/status/vocab";
import { useStrategyStatus } from "./StatusProvider";
import { StatePill } from "./primitives";

/**
 * Five independently-sourced subsystem states.
 *
 * This replaces the old static green "Dashboard Online" dot, which reported
 * nothing but that the page had rendered. Web readiness, a broker request, the
 * V11 runtime, the scheduler and the promotion evidence age separately and are
 * therefore reported separately, each with its own source and timestamp.
 */
export default function SystemStatusBar() {
  const { status, data, error } = useStrategyStatus();

  if (status === "disabled") {
    return (
      <StatusRow>
        <StatePill state="NOT_APPLICABLE" label="ACCOUNT BACKEND OFF" />
      </StatusRow>
    );
  }
  if (status === "no-account") {
    return (
      <StatusRow>
        <StatePill state="UNAVAILABLE" label="NO ACCOUNT SELECTED" />
      </StatusRow>
    );
  }
  if (status === "loading") {
    return (
      <StatusRow>
        {["Web", "Broker", "V11 runtime", "Scheduler", "Validation"].map(
          (label) => (
            <span
              key={label}
              className="skeleton h-5 w-28"
              aria-label={`${label} status loading`}
            />
          ),
        )}
      </StatusRow>
    );
  }
  if (status === "error" || !data) {
    return (
      <StatusRow>
        <StatePill state="UNAVAILABLE" label="STATUS UNAVAILABLE" />
        <span className="text-[11px] text-muted">
          {error?.message ?? "The status read model could not be loaded."}
        </span>
      </StatusRow>
    );
  }

  const indicators = systemIndicators(data);
  return (
    <StatusRow>
      {indicators.map((indicator) => (
        <span
          key={indicator.key}
          className="inline-flex items-center gap-1.5"
          title={`${indicator.label}\nSource: ${indicator.source}\nScope: ${indicator.scope}\n${absoluteTimestamps(indicator.asOf)}${
            indicator.detail ? `\n${indicator.detail}` : ""
          }`}
        >
          <span className="text-[11px] text-muted">{indicator.label}</span>
          <StatePill state={indicator.state} size="xs" />
          <span className="text-[10px] text-muted numeric hidden sm:inline">
            {formatAge(indicator.ageSeconds)}
          </span>
        </span>
      ))}
    </StatusRow>
  );
}

function StatusRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="System status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      {children}
    </div>
  );
}
