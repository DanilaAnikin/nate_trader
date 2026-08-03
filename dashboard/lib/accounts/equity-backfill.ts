import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type Service = SupabaseClient<Database>;
type Mode = Database["public"]["Enums"]["account_mode"];

const ALPACA_BASE: Record<Mode, string> = {
  paper: "https://paper-api.alpaca.markets/v2",
  live: "https://api.alpaca.markets/v2",
};

type PortfolioHistory = {
  timestamp?: number[];
  equity?: (number | null)[];
  profit_loss?: (number | null)[];
  profit_loss_pct?: (number | null)[];
};

/**
 * Backfill an account's equity curve from Alpaca's Portfolio History — the
 * real, retroactive daily equity. Idempotent: upserts on
 * (account_id, snapshot_date). Returns the number of days written.
 *
 * This is what makes the dashboard equity chart correct (DEF-01) without
 * waiting for the scheduled agent — the equity API route calls it lazily the
 * first time an account is charted.
 */
export async function backfillEquity(
  svc: Service,
  accountId: string,
  mode: Mode,
): Promise<number> {
  const { data: cred, error: credErr } = await svc.rpc(
    "get_account_credentials",
    { acct: accountId },
  );
  if (credErr || !cred || cred.length === 0) {
    throw new Error("account has no stored credentials");
  }

  const res = await fetch(
    `${ALPACA_BASE[mode]}/account/portfolio/history?period=all&timeframe=1D`,
    {
      headers: {
        "APCA-API-KEY-ID": cred[0].api_key,
        "APCA-API-SECRET-KEY": cred[0].api_secret,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Alpaca portfolio history HTTP ${res.status}`);
  }

  const hist = (await res.json()) as PortfolioHistory;
  const ts = hist.timestamp ?? [];
  const equity = hist.equity ?? [];
  const pl = hist.profit_loss ?? [];
  const plpc = hist.profit_loss_pct ?? [];

  // Keyed by date so a duplicated day collapses to its last value.
  const byDate = new Map<string, Database["public"]["Tables"]["equity_snapshots"]["Insert"]>();
  // Alpaca's daily timestamps fall in the trading day's evening, which is the
  // next calendar day in UTC — so a UTC slice mislabels Friday as Saturday and
  // drops Mondays. Format in market time (ET) so dates match the chart's
  // ET-dated SPY history. en-CA yields YYYY-MM-DD.
  const etDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  });
  for (let i = 0; i < ts.length; i++) {
    const eq = equity[i];
    if (eq == null || eq <= 0) continue;
    const date = etDate.format(new Date(ts[i] * 1000));
    byDate.set(date, {
      account_id: accountId,
      snapshot_date: date,
      equity: Math.round(eq * 100) / 100,
      // Portfolio history carries no per-day cash; only equity drives the chart.
      cash: 0,
      profit_loss: pl[i] ?? null,
      profit_loss_pct: plpc[i] ?? null,
      source: "alpaca_portfolio_history",
    });
  }

  const rows = [...byDate.values()];
  if (rows.length > 0) {
    const { error } = await svc
      .from("equity_snapshots")
      .upsert(rows, { onConflict: "account_id,snapshot_date" });
    if (error) throw new Error(`equity_snapshots upsert failed: ${error.message}`);
  }
  return rows.length;
}
