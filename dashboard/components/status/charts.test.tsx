/**
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AllocationDonut,
  ComparisonBars,
  Disclosure,
  GrowthChart,
  Legend,
  ProportionBar,
  SERIES,
  SignedBars,
} from "./charts";

describe("Disclosure", () => {
  it("keeps its (load-bearing) children in the DOM even when collapsed", () => {
    render(
      <Disclosure summary="Limitations">
        <p>survivorship and selection bias</p>
      </Disclosure>,
    );
    // A <details> keeps children mounted; the caveat is present, just collapsed.
    expect(screen.getByText(/survivorship and selection bias/)).toBeInTheDocument();
    expect(screen.getByText("Limitations")).toBeInTheDocument();
  });
});

describe("chart smoke renders", () => {
  it("renders a growth chart with a benchmark overlay without throwing", () => {
    render(
      <GrowthChart
        data={[
          { date: "2026-01-02", value: 100, benchmark: 100 },
          { date: "2026-01-03", value: 101, benchmark: 100.5 },
        ]}
        primaryName="Account equity"
        benchmarkName="SPY"
        valueFormatter={(v) => `$${v}`}
      />,
    );
    expect(screen.getByText("Account equity")).toBeInTheDocument();
    expect(screen.getByText("SPY")).toBeInTheDocument();
  });

  it("renders comparison bars with a legend", () => {
    render(
      <ComparisonBars
        data={[{ label: "15 bps", v11: 15.89, spy: 8.82 }]}
        series={[
          { key: "v11", name: "V11", color: SERIES.primary },
          { key: "spy", name: "SPY", color: SERIES.benchmark },
        ]}
        valueFormatter={(v) => `${v}%`}
      />,
    );
    expect(screen.getByText("V11")).toBeInTheDocument();
    expect(screen.getByText("SPY")).toBeInTheDocument();
  });

  it("renders signed bars and an allocation donut with a centre total", () => {
    const { container } = render(
      <>
        <SignedBars
          data={[
            { name: "MRK", value: 7213 },
            { name: "CAT", value: -2713 },
          ]}
          valueFormatter={(v) => `$${v}`}
        />
        <AllocationDonut
          data={[
            { name: "MRK", value: 47290 },
            { name: "CAT", value: 38911 },
          ]}
          valueFormatter={(v) => `$${v}`}
          centerValue="$86k"
          centerLabel="gross"
        />
      </>,
    );
    // Both chart frames mount without throwing. (recharts does not emit its
    // inner SVG in zero-size jsdom, so we assert on the ChartFrame aria-labels
    // rather than recharts internals — the page suite covers real layout.)
    expect(container.querySelector('[aria-label="Per-item values"]')).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Allocation by weight"]')).toBeInTheDocument();
  });

  it("renders a legend and a proportion bar", () => {
    render(
      <>
        <Legend items={[{ name: "Equity", color: SERIES.primary }]} />
        <ProportionBar value={46} max={100} label="Gross exposure" right="46%" />
      </>,
    );
    expect(screen.getByText("Equity")).toBeInTheDocument();
    expect(screen.getByText("Gross exposure")).toBeInTheDocument();
  });
});
