import { NextResponse } from 'next/server';
import { DEFAULT_UNIVERSE } from '@/lib/indodax';
import { INITIAL_CAPITAL, getRiskBudget } from '@/lib/risk';
import { calculatePerformanceMetrics, type DashboardTrade } from '@/lib/dashboard-metrics';
import { getStorageMode, readStoredJson } from '@/lib/storage';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const stored = await readStoredJson('indodax-dryrun-state');
    const state = stored?.state ?? null;
    const logs = Array.isArray(stored?.logs) ? stored.logs : [];
    const latestByPair = new Map<string, Record<string, any>>();
    for (const entry of logs) {
      if (typeof entry?.pair === 'string') latestByPair.set(entry.pair, entry);
    }
    const closedTrades: DashboardTrade[] = logs
      .filter((entry: Record<string, any>) => entry?.type === 'trade_closed')
      .map((entry: Record<string, any>) => ({
        pair: entry.pair,
        entryAt: entry.entryAt,
        exitAt: entry.exitAt ?? entry.timestamp,
        status: 'closed',
        grossPnl: entry.grossPnl,
        netPnl: entry.netPnl,
        fee: entry.fee,
        spreadCost: entry.spreadCost,
        slippageCost: entry.slippageCost
      }));

    return NextResponse.json({
      ok: true,
      storageMode: getStorageMode(),
      hasRun: Boolean(state?.lastRunAt),
      capital: state?.capital ?? INITIAL_CAPITAL,
      equity: state?.equity ?? null,
      dailyPnL: state?.dailyPnL ?? null,
      positions: Array.isArray(state?.positions) ? state.positions : [],
      killSwitch: typeof state?.killSwitch === 'boolean' ? state.killSwitch : null,
      lastRunAt: state?.lastRunAt ?? null,
      risk: getRiskBudget(),
      universe: DEFAULT_UNIVERSE.map((pair) => {
        const latest = latestByPair.get(pair);
        return {
          pair,
          signal: latest?.signal ?? null,
          lastRunAt: latest?.timestamp ?? null,
          validation: latest?.type === 'validation_error' ? 'rejected' : latest?.type === 'tick_run' ? 'ok' : 'waiting',
          candlesCount: latest?.candlesCount ?? null
        };
      }),
      forwardMetrics: closedTrades.length
        ? calculatePerformanceMetrics({
          mode: 'forward_test',
          initialCapital: state?.capital ?? INITIAL_CAPITAL,
          trades: closedTrades
        })
        : null,
      logs: logs.slice(-100).reverse(),
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Dashboard data unavailable';
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
