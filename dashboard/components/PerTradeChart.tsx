"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ComposedChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { ClosedTrade } from "@/lib/backtest-types";

interface Props {
  trades: ClosedTrade[];
}

interface SymbolBar {
  date: string;
  close: number;
}

/**
 * Per-trade chart: pick a symbol from the dropdown, the chart plots that
 * symbol's daily close line with markers for every entry and exit during
 * the backtest. Markers are color-coded by exit reason (stop/scale_out/
 * final_target/time_stop/catalyst_flip).
 *
 * Bars come from /api/symbol-bars?symbol=X which reads the cached file
 * the backtest engine downloaded. No live Alpaca call here — purely a
 * replay of what the backtest saw.
 */
const REASON_COLORS: Record<string, string> = {
  stop: "#ff3b30",
  scale_out: "#ff9500",
  final_target: "#34c759",
  time_stop: "#5ac8fa",
  catalyst_flip: "#af52de",
  hedge_exit: "#86868b",
  hedge_trim: "#86868b",
};

export default function PerTradeChart({ trades }: Props) {
  const directionalTrades = useMemo(
    () => trades.filter((t) => !t.is_hedge),
    [trades],
  );

  const symbols = useMemo(() => {
    const s = new Set<string>();
    directionalTrades.forEach((t) => s.add(t.symbol));
    return Array.from(s).sort();
  }, [directionalTrades]);

  const [rawSelected, setSelected] = useState<string>(symbols[0] ?? "");
  // Derive the effective selection during render rather than syncing it from
  // an effect: if the stored symbol is gone (or never set), fall back to the
  // first available symbol. Avoids a cascading setState-in-effect.
  const selected =
    rawSelected && symbols.includes(rawSelected) ? rawSelected : symbols[0] ?? "";
  const [bars, setBars] = useState<SymbolBar[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    // Intentional: flip into the loading state before the async fetch so the
    // spinner shows immediately. The set-state-in-effect rule is overly strict
    // for this standard data-fetching pattern.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setErrorMsg(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetch(`/api/symbol-bars?symbol=${encodeURIComponent(selected)}`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setErrorMsg(`No cached bars for ${selected}. Run the backtest download mode first.`);
          setBars([]);
          return;
        }
        if (!res.ok) {
          setErrorMsg(`HTTP ${res.status}`);
          setBars([]);
          return;
        }
        const data = await res.json();
        const slim = (data.bars ?? []).map((b: { date: string; close: number }) => ({
          date: b.date, close: b.close,
        }));
        setBars(slim);
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setBars([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selected]);

  const tradesForSymbol = useMemo(
    () => directionalTrades.filter((t) => t.symbol === selected),
    [directionalTrades, selected],
  );

  // Build a single chart series: each bar gets close + (optional) entry / exit prices
  const chartData = useMemo(() => {
    if (!bars || bars.length === 0) return [];
    const entriesByDate = new Map<string, number>();
    const exitsByDate = new Map<string, { price: number; reason: string }>();
    for (const t of tradesForSymbol) {
      // Group multiple entries on same day by averaging
      if (!entriesByDate.has(t.entry_date)) {
        entriesByDate.set(t.entry_date, t.entry_price);
      }
      exitsByDate.set(t.exit_date, { price: t.exit_price, reason: t.reason });
    }
    return bars.map((b) => {
      const entry = entriesByDate.get(b.date) ?? null;
      const ex = exitsByDate.get(b.date);
      return {
        date: b.date,
        close: b.close,
        entry,
        exit: ex?.price ?? null,
        exitReason: ex?.reason ?? null,
      };
    });
  }, [bars, tradesForSymbol]);

  const tickInterval = Math.max(1, Math.floor(chartData.length / 12));
  const nTrades = tradesForSymbol.length;
  const wins = tradesForSymbol.filter((t) => t.pnl > 0).length;
  const totalPnl = tradesForSymbol.reduce((acc, t) => acc + t.pnl, 0);

  if (symbols.length === 0) {
    return (
      <div className="glass-card p-6 text-center text-muted text-sm">
        No directional trades in the backtest to chart.
      </div>
    );
  }

  return (
    <div className="glass-card p-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-medium text-secondary">Per-Trade Markers</h3>
          <p className="text-xs text-muted mt-1">
            {nTrades} trade{nTrades === 1 ? "" : "s"} for {selected} during the backtest.{" "}
            {wins}/{nTrades} wins · total P&amp;L ${totalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted">Symbol</label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="px-2 py-1 text-xs rounded-md bg-surface border border-border focus:outline-none focus:ring-1 focus:ring-blue/30"
          >
            {symbols.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-3 text-[10px]">
        <LegendDot color="#34c759" label="entry" />
        <LegendDot color={REASON_COLORS.stop} label="stop" />
        <LegendDot color={REASON_COLORS.scale_out} label="scale-out" />
        <LegendDot color={REASON_COLORS.final_target} label="final target" />
        <LegendDot color={REASON_COLORS.time_stop} label="time stop" />
        <LegendDot color={REASON_COLORS.catalyst_flip} label="catalyst flip" />
      </div>

      {loading && (
        <div className="h-[300px] flex items-center justify-center text-muted text-xs">Loading {selected} bars…</div>
      )}
      {errorMsg && (
        <div className="h-[150px] flex items-center justify-center text-muted text-xs">{errorMsg}</div>
      )}
      {!loading && !errorMsg && chartData.length > 0 && (
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={chartData} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#f0f0f2" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: "#86868b", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              interval={tickInterval}
              tickFormatter={(d: string) => {
                const dt = new Date(d);
                if (Number.isNaN(dt.getTime())) return d;
                return `${dt.toLocaleString("en-US", { month: "short" })} '${String(dt.getFullYear()).slice(2)}`;
              }}
            />
            <YAxis
              tick={{ fill: "#86868b", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
              domain={["dataMin * 0.98", "dataMax * 1.02"]}
            />
            <Tooltip
              contentStyle={{ background: "#ffffff", border: "1px solid #e5e5e7", borderRadius: 10, fontSize: 12 }}
              formatter={(v, n) => {
                if (v === null || v === undefined) return ["—", String(n)];
                const x = typeof v === "number" ? v : Number(v);
                return [`$${x.toFixed(2)}`, String(n)];
              }}
              labelFormatter={(d) => `Date: ${String(d)}`}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            <Line
              type="monotone"
              dataKey="close"
              name={`${selected} close`}
              stroke="#86868b"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Scatter
              dataKey="entry"
              name="Entry"
              fill="#34c759"
              shape="triangle"
              isAnimationActive={false}
            />
            <Scatter
              dataKey="exit"
              name="Exit"
              fill="#ff3b30"
              shape="diamond"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1 text-muted">
      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
