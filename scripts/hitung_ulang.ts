import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_UNIVERSE, type Candle } from '../lib/indodax';
import { calculatePerformanceMetrics } from '../lib/dashboard-metrics';
import { simulatePortfolio } from './backtest';

type ForwardReplay = {
  version: 1;
  type: 'historical_forward_replay';
  source: string;
  timeframe: '1h';
  startAt: string;
  requestedEndAt: string;
  dataThrough: string;
  complete: boolean;
  candles: Record<string, number[][]>;
  decisions: Array<Record<string, unknown>>;
  report: {
    benchmarkReturnPercent: number;
    trades: unknown[];
    equityCurve: unknown[];
  };
};

const replayHistoricalForwardTest = () => {
  const root = process.cwd();
  const archivePath = path.join(root, 'public', 'data', 'forward-replay.json');
  if (!fs.existsSync(archivePath)) {
    throw new Error('Arsip forward-replay.json tidak ditemukan. Jalankan npm run backtest terlebih dahulu.');
  }

  const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8')) as ForwardReplay;
  assert.equal(archive.version, 1);
  assert.equal(archive.type, 'historical_forward_replay');
  assert.equal(archive.timeframe, '1h');
  assert.ok(Date.parse(archive.dataThrough) > Date.parse(archive.startAt));

  const series = Object.fromEntries(DEFAULT_UNIVERSE.map((pair) => {
    const raw = archive.candles[pair];
    assert.ok(Array.isArray(raw) && raw.length > 0, `Candle replay kosong untuk ${pair}.`);
    const candles: Candle[] = raw.map(([time, open, high, low, close, volume]) => ({
      time,
      open,
      high,
      low,
      close,
      volume,
      isClosed: true
    }));
    return [pair, candles];
  })) as Record<string, Candle[]>;

  const activeFrom = Math.floor(Date.parse(archive.startAt) / 1000);
  const result = simulatePortfolio(
    series,
    archive.startAt,
    archive.dataThrough,
    archive.report.benchmarkReturnPercent,
    activeFrom,
    'forward_test'
  );

  assert.deepEqual(result.decisions, archive.decisions, 'Keputusan sinyal berbeda dari arsip replay.');
  assert.deepEqual(result.report.trades, archive.report.trades, 'Daftar trade berbeda dari report tersimpan.');
  assert.deepEqual(result.report.equityCurve, archive.report.equityCurve, 'Equity curve berbeda dari report tersimpan.');

  const metrics = calculatePerformanceMetrics({ ...result.report, benchmarkReturnPercent: archive.report.benchmarkReturnPercent });
  const summary = {
    provenance: archive.type,
    source: archive.source,
    startAt: archive.startAt,
    requestedEndAt: archive.requestedEndAt,
    dataThrough: archive.dataThrough,
    complete: archive.complete,
    candleCount: Object.values(archive.candles).reduce((total, candles) => total + candles.length, 0),
    decisions: result.decisions.length,
    buySignals: result.decisions.filter((decision) => decision.signal === 'BUY').length,
    sellSignals: result.decisions.filter((decision) => decision.signal === 'SELL').length,
    trades: result.report.trades.length,
    metrics
  };

  console.log(JSON.stringify(summary, null, 2));
  return summary;
};

if (process.argv[1] && path.resolve(process.argv[1]).includes('hitung_ulang.ts')) {
  try {
    replayHistoricalForwardTest();
  } catch (error) {
    console.error('Verifikasi replay historis gagal:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}