import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_UNIVERSE, fetchIndodaxHistory, type Candle } from '../lib/indodax';
import { calculatePerformanceMetrics, type DashboardTrade, type PerformanceReport } from '../lib/dashboard-metrics';
import { computeStrategySignal, type Signal } from '../lib/strategy';

export const FREEZE_AT = '2026-11-04T05:00:00.000Z';
export const FORWARD_END_AT = '2026-11-14T05:00:00.000Z';

const INTERVAL_MS = 60 * 60 * 1000;
const BAR_SECONDS = INTERVAL_MS / 1000;
export const getForwardWindowEndMs = (nowMs: number, requestedEndMs = Date.parse(FORWARD_END_AT)) =>
  Math.min(requestedEndMs, Math.floor(nowMs / INTERVAL_MS) * INTERVAL_MS);
const REQUEST_DELAY_MS = 350;
const MAX_PAGES_PER_PAIR = 100;
const INITIAL_CAPITAL = 100_000_000;
const MAX_POSITIONS = 3;
const MAX_POSITION_IDR = INITIAL_CAPITAL * 0.2;
const DAILY_LOSS_LIMIT_IDR = INITIAL_CAPITAL * 0.12;
const FEE_RATE = 0.0015;
const SLIPPAGE_RATE = 0.0005;

type SimulatedPosition = {
  pair: string;
  quantity: number;
  entryAt: number;
  entryReferencePrice: number;
  entryExecutionPrice: number;
  entryFee: number;
};
type SignalEvent = { pair: string; signal: 'BUY' | 'SELL' };
type SignalDecision = { pair: string; signalAt: number; executionAt: number; signal: Signal; reason: string[] };

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

const fetchIndodaxCandles = async (pair: string, startSeconds: number, endSeconds: number): Promise<Candle[]> => {
  const byTime = new Map<number, Candle>();
  let cursor = endSeconds - 1;
  let page = 0;

  while (cursor > startSeconds) {
    page += 1;
    if (page > MAX_PAGES_PER_PAIR) throw new Error(`${pair}: exceeded ${MAX_PAGES_PER_PAIR} history pages.`);

    const result = await fetchIndodaxHistory(pair, '1h', startSeconds, cursor);
    const candles = result.candles
      .filter((candle) => candle.time >= startSeconds && candle.time <= cursor && candle.time < endSeconds)
      .sort((a, b) => a.time - b.time);
    if (!candles.length) {
      const error = result.issues.find((issue) => issue.severity === 'error');
      throw new Error(`${pair}: no candles on history page ${page}${error ? ` (${error.code}: ${error.message})` : ''}.`);
    }

    for (const candle of candles) byTime.set(candle.time, candle);
    const oldestTime = candles[0].time;
    if (oldestTime <= startSeconds) break;
    if (oldestTime >= cursor) throw new Error(`${pair}: history pagination stalled at ${oldestTime}.`);
    cursor = oldestTime - 1;
    if (page % 5 === 0) console.log(`  ${pair}: ${byTime.size.toLocaleString('id-ID')} candle`);
    await sleep(REQUEST_DELAY_MS);
  }

  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (candles.length < 200) throw new Error(`Indodax returned only ${candles.length} closed candles for ${pair}.`);
  if (candles[0].time > startSeconds + BAR_SECONDS * 2) throw new Error(`${pair}: history does not reach the three-year start date.`);
  return candles;
};

const makeSignalEvents = (series: Record<string, Candle[]>, decisionStart: number, decisionEnd: number) => {
  const events = new Map<number, SignalEvent[]>();
  const decisions: SignalDecision[] = [];
  for (const pair of DEFAULT_UNIVERSE) {
    const candles = series[pair];
    for (let index = 199; index < candles.length - 1; index += 1) {
      const window = candles.slice(Math.max(0, index - 249), index + 1);
      const executionTime = candles[index + 1].time;
      const result = computeStrategySignal(window);
      if (executionTime >= decisionStart && executionTime < decisionEnd) {
        decisions.push({ pair, signalAt: candles[index].time, executionAt: executionTime, signal: result.signal, reason: result.reason });
      }
      const signal = result.signal;
      if (signal === 'HOLD') continue;
      const atTime = events.get(executionTime) ?? [];
      atTime.push({ pair, signal });
      events.set(executionTime, atTime);
    }
    console.log(`  ${pair}: signal scan complete`);
  }
  return { events, decisions };
};

const aggregateDaily = (candles: Candle[]) => {
  const daily = new Map<number, Candle>();
  for (const candle of candles) {
    const dayTime = Math.floor(candle.time / 86_400) * 86_400;
    const existing = daily.get(dayTime);
    if (existing) {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume += candle.volume;
    } else {
      daily.set(dayTime, { ...candle, time: dayTime });
    }
  }
  return [...daily.values()].map((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume]);
};

export const simulatePortfolio = (series: Record<string, Candle[]>, startAt: string, endAt: string, benchmarkReturnPercent: number, activeFrom?: number, mode: PerformanceReport['mode'] = 'backtest') => {
  const timeline = [...new Set(DEFAULT_UNIVERSE.flatMap((pair) => series[pair].map((candle) => candle.time)))].sort((a, b) => a - b);
  if (!timeline.length) throw new Error('Tidak ada candle untuk disimulasikan.');
  const decisionStart = activeFrom ?? timeline[0];
  const decisionEnd = Math.floor(Date.parse(endAt) / 1000);
  const { events, decisions } = makeSignalEvents(series, decisionStart, decisionEnd);
  const indexes = Object.fromEntries(DEFAULT_UNIVERSE.map((pair) => [pair, 0])) as Record<string, number>;
  const lastCloses: Record<string, number> = {};
  const positions = new Map<string, SimulatedPosition>();
  const trades: DashboardTrade[] = [];
  const equityCurve: Array<{ timestamp: number; equity: number }> = [{ timestamp: activeFrom ?? timeline[0], equity: INITIAL_CAPITAL }];
  let cash = INITIAL_CAPITAL;
  let currentDay = '';
  let dailyRealizedPnl = 0;

  const closePosition = (pair: string, candle: Candle, referencePrice: number, timestamp: number) => {
    const position = positions.get(pair);
    if (!position) return;
    const executionPrice = referencePrice * (1 - SLIPPAGE_RATE);
    const exitNotional = position.quantity * executionPrice;
    const exitFee = exitNotional * FEE_RATE;
    const fees = position.entryFee + exitFee;
    const slippageCost = position.quantity * (position.entryExecutionPrice - position.entryReferencePrice)
      + position.quantity * (referencePrice - executionPrice);
    const grossPnl = position.quantity * (referencePrice - position.entryReferencePrice);
    const netPnl = grossPnl - fees - slippageCost;
    cash += exitNotional - exitFee;
    dailyRealizedPnl += netPnl;
    trades.push({
      pair,
      entryAt: position.entryAt,
      exitAt: timestamp,
      status: 'closed',
      quantity: position.quantity,
      entryPrice: position.entryReferencePrice,
      exitPrice: referencePrice,
      grossPnl,
      netPnl,
      fee: fees,
      spreadCost: 0,
      slippageCost
    });
    positions.delete(pair);
  };

  for (let timeIndex = 0; timeIndex < timeline.length; timeIndex += 1) {
    const time = timeline[timeIndex];
    const nextTime = timeline[timeIndex + 1];
    const bars = new Map<string, Candle>();
    for (const pair of DEFAULT_UNIVERSE) {
      const pairCandles = series[pair];
      let index = indexes[pair];
      while (index < pairCandles.length && pairCandles[index].time < time) index += 1;
      indexes[pair] = index;
      if (pairCandles[index]?.time === time) {
        bars.set(pair, pairCandles[index]);
        lastCloses[pair] = pairCandles[index].close;
        indexes[pair] = index + 1;
      }
    }

    const day = new Date((time + 7 * 60 * 60) * 1000).toISOString().slice(0, 10);
    const isNewDay = day !== currentDay;
    if (isNewDay) {
      currentDay = day;
      dailyRealizedPnl = 0;
    }

    if (activeFrom !== undefined && time < activeFrom) continue;

    const atTime = events.get(time) ?? [];
    for (const event of atTime.filter((item) => item.signal === 'SELL')) {
      const bar = bars.get(event.pair);
      if (bar) closePosition(event.pair, bar, bar.open, time);
    }

    if (dailyRealizedPnl > -DAILY_LOSS_LIMIT_IDR && positions.size < MAX_POSITIONS) {
      for (const event of atTime.filter((item) => item.signal === 'BUY').sort((a, b) => a.pair.localeCompare(b.pair))) {
        const bar = bars.get(event.pair);
        if (!bar || positions.has(event.pair) || positions.size >= MAX_POSITIONS) continue;
        const referencePrice = bar.open;
        const executionPrice = referencePrice * (1 + SLIPPAGE_RATE);
        const maxNotional = Math.min(MAX_POSITION_IDR, cash / (1 + FEE_RATE));
        const quantity = maxNotional / executionPrice;
        const entryNotional = quantity * executionPrice;
        const entryFee = entryNotional * FEE_RATE;
        if (!Number.isFinite(quantity) || quantity <= 0 || entryNotional + entryFee > cash) continue;
        cash -= entryNotional + entryFee;
        positions.set(event.pair, {
          pair: event.pair,
          quantity,
          entryAt: time,
          entryReferencePrice: referencePrice,
          entryExecutionPrice: executionPrice,
          entryFee
        });
      }
    }

    const equity = cash + [...positions.values()].reduce((value, position) => {
      return value + position.quantity * (lastCloses[position.pair] ?? position.entryReferencePrice);
    }, 0);
    const isLastCandleOfDay = !nextTime
      || new Date((nextTime + 7 * 60 * 60) * 1000).toISOString().slice(0, 10) !== day;
    if (isLastCandleOfDay && time >= decisionStart) {
      equityCurve.push({ timestamp: Math.min(time + BAR_SECONDS, decisionEnd), equity });
    }
  }

  const finalTime = Math.min(timeline[timeline.length - 1] + BAR_SECONDS, decisionEnd);
  for (const [pair, position] of [...positions]) {
    const finalPrice = lastCloses[pair] ?? position.entryReferencePrice;
    closePosition(pair, { time: finalTime, open: finalPrice, high: finalPrice, low: finalPrice, close: finalPrice, volume: 0, isClosed: true }, finalPrice, finalTime);
  }
  const finalPoint = { timestamp: finalTime, equity: cash };
  if (equityCurve[equityCurve.length - 1]?.timestamp === finalTime) equityCurve[equityCurve.length - 1] = finalPoint;
  else equityCurve.push(finalPoint);

  const report: PerformanceReport & { source: string; assumptions: Record<string, string | number> } = {
    mode,
    startAt,
    endAt,
    initialCapital: INITIAL_CAPITAL,
    benchmarkReturnPercent,
    trades,
    equityCurve,
    source: 'Indodax public history_v2 API (native IDR pairs)',
    assumptions: {
      candleInterval: '1h',
      entryExitFill: 'next candle open after signal candle closes',
      feeRatePerSide: FEE_RATE,
      slippageRatePerSide: SLIPPAGE_RATE,
      historicalSpread: 'Historical order book unavailable; spreadCost recorded as 0 and slippage modeled separately',
      maxPositions: MAX_POSITIONS,
      maxPositionIdr: MAX_POSITION_IDR,
      dailyLossLimitIdr: DAILY_LOSS_LIMIT_IDR
    }
  };
  return { report, equityCurve, decisions };
};

export const runBacktest = async () => {
  const freezeMs = Date.parse(FREEZE_AT);
  const forwardEndMs = Date.parse(FORWARD_END_AT);
  if (!Number.isFinite(freezeMs) || !Number.isFinite(forwardEndMs)) {
    throw new Error(`Freeze window tidak valid: ${FREEZE_AT} sampai ${FORWARD_END_AT}.`);
  }
  const startDate = new Date(freezeMs);
  startDate.setUTCFullYear(startDate.getUTCFullYear() - 3);
  const startMs = startDate.getTime();
  const startAt = iso(startMs);
  const endAt = iso(freezeMs);
  const requestedForwardEndAt = iso(forwardEndMs);
  const startSeconds = Math.floor(startMs / 1000);
  const freezeSeconds = Math.floor(freezeMs / 1000);
  const requestedForwardEndSeconds = Math.floor(forwardEndMs / 1000);
  const forwardFetchEndSeconds = Math.floor(getForwardWindowEndMs(Date.now()) / 1000);
  if (forwardFetchEndSeconds <= freezeSeconds) {
    throw new Error('Waktu sekarang belum melewati freeze date; forward replay belum dapat dibuat.');
  }

  console.log(`Freeze ${endAt}; backtest ${startAt} sampai ${endAt}.`);
  const series: Record<string, Candle[]> = {};
  for (const pair of DEFAULT_UNIVERSE) {
    console.log(`Mengunduh histori Indodax ${pair}...`);
    series[pair] = await fetchIndodaxCandles(pair, startSeconds, freezeSeconds);
    console.log(`  ${series[pair].length.toLocaleString('id-ID')} candle tertutup dari ${iso(series[pair][0].time * 1000)} sampai ${iso(series[pair][series[pair].length - 1].time * 1000)}.`);
  }

  const btc = series['BTC/IDR'];
  const benchmarkReturnPercent = ((btc[btc.length - 1].close / btc[0].close) - 1) * 100;
  const { report } = simulatePortfolio(series, startAt, endAt, benchmarkReturnPercent);
  const metrics = calculatePerformanceMetrics(report);

  const forwardSeries: Record<string, Candle[]> = {};
  const forwardWarmupSeconds = freezeSeconds - 250 * BAR_SECONDS;
  for (const pair of DEFAULT_UNIVERSE) {
    console.log(`Mengunduh histori replay ${pair} (${FREEZE_AT} sampai ${requestedForwardEndAt}; tersedia hingga ${iso(forwardFetchEndSeconds * 1000)})...`);
    forwardSeries[pair] = await fetchIndodaxCandles(pair, forwardWarmupSeconds, forwardFetchEndSeconds);
  }

  const observedEndSeconds = Math.min(forwardFetchEndSeconds, ...DEFAULT_UNIVERSE.map((pair) => {
    const candles = forwardSeries[pair].filter((candle) => candle.time >= freezeSeconds);
    return candles.length ? candles[candles.length - 1].time + BAR_SECONDS : freezeSeconds;
  }));
  if (observedEndSeconds <= freezeSeconds) throw new Error('Tidak ada rentang candle tertutup setelah freeze date.');
  const observedEndAt = iso(observedEndSeconds * 1000);
  const observedSeries = Object.fromEntries(DEFAULT_UNIVERSE.map((pair) => [
    pair,
    forwardSeries[pair].filter((candle) => candle.time < observedEndSeconds)
  ])) as Record<string, Candle[]>;
  const forwardBtc = observedSeries['BTC/IDR'].filter((candle) => candle.time >= freezeSeconds);
  if (!forwardBtc.length) throw new Error('Data historis BTC/IDR untuk forward test tidak tersedia.');
  const forwardBenchmarkReturnPercent = ((forwardBtc[forwardBtc.length - 1].close / forwardBtc[0].close) - 1) * 100;
  const forwardSimulation = simulatePortfolio(observedSeries, FREEZE_AT, observedEndAt, forwardBenchmarkReturnPercent, freezeSeconds, 'forward_test');
  const complete = observedEndSeconds >= requestedForwardEndSeconds;
  const forwardReport: PerformanceReport & { assumptions: Record<string, string | number> } = {
    ...forwardSimulation.report,
    source: 'Retrospective replay of Indodax history_v2 candles; not live tick or order-book logs',
    provenance: 'historical_replay',
    requestedEndAt: requestedForwardEndAt,
    dataThrough: observedEndAt,
    complete,
    assumptions: {
      ...forwardSimulation.report.assumptions,
      replayType: 'historical candle replay, not live forward-test execution',
      requestedEndAt: requestedForwardEndAt,
      observedDataThrough: observedEndAt,
      periodComplete: complete ? 'yes' : 'no'
    }
  };
  const forwardMetrics = calculatePerformanceMetrics(forwardReport);
  const forwardReplay = {
    version: 1,
    type: 'historical_forward_replay',
    source: 'Indodax public history_v2 API (native IDR pairs)',
    timeframe: '1h',
    startAt: FREEZE_AT,
    requestedEndAt: requestedForwardEndAt,
    dataThrough: observedEndAt,
    complete,
    generatedAt: new Date().toISOString(),
    disclaimer: 'Retrospective replay from exchange candles. This is not a record of live bot invocations, order-book snapshots, or live simulated fills.',
    candles: Object.fromEntries(DEFAULT_UNIVERSE.map((pair) => [
      pair,
      forwardSeries[pair].filter((candle) => candle.time < observedEndSeconds)
        .map((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume])
    ])),
    decisions: forwardSimulation.decisions,
    report: forwardReport
  };
  const market = DEFAULT_UNIVERSE.map((pair) => {
    const candles = series[pair];
    const last = candles[candles.length - 1];
    const prev = candles[Math.max(0, candles.length - 25)];
    return { pair, price: last.close, change: ((last.close / prev.close) - 1) * 100, lastUpdated: last.time };
  });
  const seed = {
    version: 1,
    frozen: {
      source: report.source,
      startAt,
      freezeAt: endAt,
      forwardEndAt: requestedForwardEndAt,
      forwardDataThrough: observedEndAt,
      forwardComplete: complete,
      timeframe: '1h',
      createdAt: new Date().toISOString(),
      candleSource: 'Indodax history_v2'
    },
    candles: Object.fromEntries(DEFAULT_UNIVERSE.map((pair) => [pair, aggregateDaily(series[pair])])),
    market,
    reports: { backtest: report, forward_test: forwardReport },
    snapshot: null,
    logs: [],
    validation: DEFAULT_UNIVERSE.map((pair) => ({
      pair,
      candleCount: series[pair].length,
      firstAt: series[pair][0].time,
      lastAt: series[pair][series[pair].length - 1].time,
      source: report.source
    }))
  };

  const root = process.cwd();
  const dataDirectory = path.join(root, 'public', 'data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(path.join(dataDirectory, 'backtest.json'), `${JSON.stringify(report)}\n`);
  fs.writeFileSync(path.join(dataDirectory, 'forward-test.json'), `${JSON.stringify(forwardReport)}\n`);
  fs.writeFileSync(path.join(dataDirectory, 'forward-replay.json'), `${JSON.stringify(forwardReplay)}\n`);
  fs.writeFileSync(path.join(dataDirectory, 'backtest-summary.json'), `${JSON.stringify({ source: report.source, startAt, endAt, metrics, forwardMetrics, forwardRequestedEndAt: requestedForwardEndAt, forwardDataThrough: observedEndAt, forwardComplete: complete, assumptions: report.assumptions }, null, 2)}\n`);
  const dashboardPath = path.join(root, 'public', 'dashboard.html');
  const dashboard = fs.readFileSync(dashboardPath, 'utf8');
  const serializedSeed = JSON.stringify(seed).replace(/</g, '\\u003c');
  const embedded = dashboard.replace(/(<script id="offline-seed" type="application\/json">)[\s\S]*?(<\/script>)/, `$1${serializedSeed}$2`);
  if (embedded === dashboard) throw new Error('Embedded offline seed element not found in public/dashboard.html.');
  fs.writeFileSync(dashboardPath, embedded);

  console.log(`Report ${path.join(dataDirectory, 'backtest.json')}`);
  console.log(JSON.stringify({
    source: report.source,
    startAt,
    endAt,
    forwardStartAt: FREEZE_AT,
    forwardRequestedEndAt: requestedForwardEndAt,
    forwardDataThrough: observedEndAt,
    forwardComplete: complete,
    backtestTrades: metrics.tradeCount,
    forwardTrades: forwardMetrics.tradeCount,
    backtestTotalReturnPercent: metrics.totalReturnPercent,
    forwardTotalReturnPercent: forwardMetrics.totalReturnPercent,
    maxDrawdownPercent: metrics.maxDrawdownPercent,
    profitFactor: metrics.profitFactor,
    winRatePercent: metrics.winRatePercent
  }, null, 2));
  return { report, forwardReport, forwardReplay, seed, metrics, forwardMetrics };
};

if (process.argv[1] && path.resolve(process.argv[1]).includes('backtest.ts')) {
  runBacktest().catch((error) => {
    console.error('Backtest gagal:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
