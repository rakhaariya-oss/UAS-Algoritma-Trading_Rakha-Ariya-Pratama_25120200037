export type DashboardTrade = {
  pair?: string;
  entryAt?: string | number;
  exitAt?: string | number;
  status?: string;
  quantity?: number;
  entryPrice?: number;
  exitPrice?: number;
  grossPnl?: number;
  netPnl?: number;
  fee?: number;
  spreadCost?: number;
  slippageCost?: number;
};

export type EquityPoint = {
  timestamp: string | number;
  equity: number;
};

export type PerformanceReport = {
  mode: 'backtest' | 'forward_test';
  provenance?: 'historical_replay' | 'live_forward';
  requestedEndAt?: string | number;
  dataThrough?: string | number;
  complete?: boolean;
  source?: string;
  assumptions?: Record<string, string | number>;
  startAt?: string | number;
  endAt?: string | number;
  initialCapital: number;
  benchmarkReturnPercent?: number;
  trades: DashboardTrade[];
  equityCurve?: EquityPoint[];
};

export type PerformanceMetrics = {
  initialCapital: number;
  finalEquity: number | null;
  totalReturnPercent: number | null;
  cagrPercent: number | null;
  maxDrawdownPercent: number | null;
  profitFactor: number | null;
  winRatePercent: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  tradeCount: number;
  fees: number;
  spreadCost: number;
  slippageCost: number;
  costsAsPercentOfGrossProfit: number | null;
  benchmarkReturnPercent: number | null;
  gapVsBenchmarkPercent: number | null;
};

const finiteNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const timestampMs = (value: string | number | undefined) => {
  if (typeof value === 'number') return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const isClosedTrade = (trade: DashboardTrade) => {
  const status = trade.status?.toLowerCase();
  return status === undefined || status === 'closed' || status === 'filled';
};

export const calculatePerformanceMetrics = (report: PerformanceReport): PerformanceMetrics => {
  const initialCapital = finiteNumber(report.initialCapital) ?? 0;
  const trades = report.trades.filter(isClosedTrade);
  const netResults = trades.map((trade) => {
    const explicitNet = finiteNumber(trade.netPnl);
    if (explicitNet !== null) return explicitNet;
    const gross = finiteNumber(trade.grossPnl) ?? 0;
    const fees = finiteNumber(trade.fee) ?? 0;
    const spread = finiteNumber(trade.spreadCost) ?? 0;
    const slippage = finiteNumber(trade.slippageCost) ?? 0;
    return gross - fees - spread - slippage;
  });
  const grossProfit = trades.reduce((total, trade) => total + Math.max(0, finiteNumber(trade.grossPnl) ?? 0), 0);
  const grossLoss = Math.abs(trades.reduce((total, trade) => total + Math.min(0, finiteNumber(trade.grossPnl) ?? 0), 0));
  const winningTrades = netResults.filter((pnl) => pnl > 0);
  const losingTrades = netResults.filter((pnl) => pnl < 0);
  const fees = trades.reduce((total, trade) => total + (finiteNumber(trade.fee) ?? 0), 0);
  const spreadCost = trades.reduce((total, trade) => total + (finiteNumber(trade.spreadCost) ?? 0), 0);
  const slippageCost = trades.reduce((total, trade) => total + (finiteNumber(trade.slippageCost) ?? 0), 0);
  const totalNetPnl = netResults.reduce((total, pnl) => total + pnl, 0);
  const curve = [...(report.equityCurve ?? [])]
    .map((point) => ({ timestamp: timestampMs(point.timestamp), equity: finiteNumber(point.equity) }))
    .filter((point): point is { timestamp: number; equity: number } => point.timestamp !== null && point.equity !== null)
    .sort((a, b) => a.timestamp - b.timestamp);
  const finalEquity = curve.length ? curve[curve.length - 1].equity : initialCapital + totalNetPnl;
  const startAt = timestampMs(report.startAt);
  const endAt = timestampMs(report.endAt);
  const durationDays = startAt !== null && endAt !== null ? (endAt - startAt) / 86_400_000 : 0;
  const cagrPercent = initialCapital > 0 && finalEquity > 0 && durationDays > 0
    ? (Math.pow(finalEquity / initialCapital, 365 / durationDays) - 1) * 100
    : null;
  let peak = initialCapital;
  let maxDrawdownPercent: number | null = null;

  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      const drawdown = ((peak - point.equity) / peak) * 100;
      maxDrawdownPercent = Math.max(maxDrawdownPercent ?? 0, drawdown);
    }
  }

  if (!curve.length && trades.length) {
    let equity = initialCapital;
    const datedResults = trades
      .map((trade, index) => ({ timestamp: timestampMs(trade.exitAt), pnl: netResults[index] }))
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

    for (const result of datedResults) {
      equity += result.pnl;
      peak = Math.max(peak, equity);
      if (peak > 0) {
        maxDrawdownPercent = Math.max(maxDrawdownPercent ?? 0, ((peak - equity) / peak) * 100);
      }
    }
  }

  const benchmarkReturnPercent = finiteNumber(report.benchmarkReturnPercent);

  return {
    initialCapital,
    finalEquity,
    totalReturnPercent: initialCapital > 0 ? ((finalEquity - initialCapital) / initialCapital) * 100 : null,
    cagrPercent,
    maxDrawdownPercent,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : null,
    winRatePercent: netResults.length ? (winningTrades.length / netResults.length) * 100 : null,
    averageWin: winningTrades.length ? winningTrades.reduce((sum, pnl) => sum + pnl, 0) / winningTrades.length : null,
    averageLoss: losingTrades.length ? losingTrades.reduce((sum, pnl) => sum + pnl, 0) / losingTrades.length : null,
    tradeCount: trades.length,
    fees,
    spreadCost,
    slippageCost,
    costsAsPercentOfGrossProfit: grossProfit > 0 ? ((fees + spreadCost + slippageCost) / grossProfit) * 100 : null,
    benchmarkReturnPercent,
    gapVsBenchmarkPercent: benchmarkReturnPercent === null || initialCapital <= 0
      ? null
      : ((finalEquity - initialCapital) / initialCapital) * 100 - benchmarkReturnPercent
  };
};

export const isPerformanceReport = (value: unknown): value is PerformanceReport => {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<PerformanceReport>;
  return (report.mode === 'backtest' || report.mode === 'forward_test')
    && Number.isFinite(Number(report.initialCapital))
    && Number(report.initialCapital) > 0
    && Array.isArray(report.trades)
    && report.trades.every((trade) => trade !== null && typeof trade === 'object')
    && (report.equityCurve === undefined || Array.isArray(report.equityCurve));
};
