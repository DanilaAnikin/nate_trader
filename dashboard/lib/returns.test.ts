import { describe, it, expect } from "vitest";
import { simpleReturn, twr } from "./returns";

describe("simpleReturn", () => {
  it("is 0 with fewer than two points", () => {
    expect(simpleReturn([])).toBe(0);
    expect(simpleReturn([{ date: "a", equity: 100 }])).toBe(0);
  });

  it("computes end / start - 1", () => {
    expect(
      simpleReturn([
        { date: "a", equity: 100 },
        { date: "b", equity: 110 },
      ]),
    ).toBeCloseTo(0.1);
  });

  it("is 0 when the starting equity is non-positive", () => {
    expect(
      simpleReturn([
        { date: "a", equity: 0 },
        { date: "b", equity: 110 },
      ]),
    ).toBe(0);
  });
});

describe("twr", () => {
  it("is 0 with fewer than two points", () => {
    expect(twr([])).toBe(0);
  });

  it("matches the simple return when there are no cash flows", () => {
    const pts = [
      { date: "a", equity: 100 },
      { date: "b", equity: 110 },
      { date: "c", equity: 121 },
    ];
    expect(twr(pts)).toBeCloseTo(0.21);
  });

  it("excludes a deposit from the return", () => {
    // Equity 100 -> 200, but 100 of that was a deposit on day b => 0% return.
    const pts = [
      { date: "a", equity: 100 },
      { date: "b", equity: 200 },
    ];
    expect(twr(pts, new Map([["b", 100]]))).toBeCloseTo(0);
  });
});
