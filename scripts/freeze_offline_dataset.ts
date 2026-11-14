import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_UNIVERSE, fetchIndodaxHistory, type Candle } from '../lib/indodax';

const TIMEFRAME = '1h' as const;
const BAR_SECONDS = 60 * 60;
const START_AT = '2023-11-04T05:00:00.000Z';
const FREEZE_AT = '2026-11-04T05:00:00.000Z';
const FORWARD_END_AT = '2026-11-14T05:00:00.000Z';
const REQUEST_DELAY_MS = 350;
const MAX_PAGES_PER_PAIR = 100;

const startTime = Math.floor(Date.parse(START_AT) / 1000);
const freezeTime = Math.floor(Date.parse(FREEZE_AT) / 1000);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type FrozenSeed = {
  version: 1;
  frozen: {
    source: 'Indodax';
    startAt: string;
    freezeAt: string;
    forwardEndAt: string;
    timeframe: typeof TIMEFRAME;
    createdAt: string;
    pageLimit: number;
  };
  candles: Record<string, number[][]>;
  market: Array<{ pair: string; price: number; change: null; lastUpdated: number }>;
  reports: Record<string, never>;
  snapshot: null;
  logs: [];
  validation: Array<{ pair: string; candleCount: number; gaps: number; firstAt: number; lastAt: number }>;
};

const fetchPairHistory = async (pair: string): Promise<Candle[]> => {
  const candlesByTime = new Map<number, Candle>();
  let cursor = freezeTime - 1;
  let page = 0;

  while (cursor > startTime) {
    page += 1;
    if (page > MAX_PAGES_PER_PAIR) {
      throw new Error(`${pair}: melebihi ${MAX_PAGES_PER_PAIR} halaman histori.`);
    }

    let result: Awaited<ReturnType<typeof fetchIndodaxHistory>> | null = null;
    let lastError = 'Indodax tidak mengembalikan data.';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await fetchIndodaxHistory(pair, TIMEFRAME, startTime, cursor);
      if (result.candles.length) break;
      lastError = result.issues.find((issue) => issue.severity === 'error')?.message ?? lastError;
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }

    const candles = (result?.candles ?? [])
      .filter((candle) => candle.time >= startTime && candle.time <= cursor && candle.time < freezeTime)
      .sort((a, b) => a.time - b.time);
    if (!candles.length) {
      throw new Error(`${pair}: histori berhenti di halaman ${page}. ${lastError}`);
    }

    for (const candle of candles) candlesByTime.set(candle.time, candle);
    const oldestTime = candles[0].time;
    if (oldestTime <= startTime) break;
    if (oldestTime >= cursor) throw new Error(`${pair}: pagination tidak bergerak mundur pada halaman ${page}.`);
    cursor = oldestTime - 1;
    await sleep(REQUEST_DELAY_MS);
  }

  const candles = [...candlesByTime.values()].sort((a, b) => a.time - b.time);
  if (!candles.length || candles[0].time > startTime + BAR_SECONDS * 2 || candles[candles.length - 1].time < freezeTime - BAR_SECONDS * 2) {
    throw new Error(`${pair}: rentang histori tidak mencakup tanggal awal/freeze yang diminta.`);
  }
  return candles;
};

export const freezeOfflineDataset = async () => {
  const candles: Record<string, number[][]> = {};
  const market: FrozenSeed['market'] = [];
  const validation: FrozenSeed['validation'] = [];

  for (const pair of DEFAULT_UNIVERSE) {
    console.log(`Mengunduh ${pair} (${START_AT} sampai ${FREEZE_AT})...`);
    const series = await fetchPairHistory(pair);
    const gaps = series.reduce((count, candle, index) => {
      if (index === 0) return count;
      return count + (candle.time - series[index - 1].time > BAR_SECONDS * 2 ? 1 : 0);
    }, 0);
    candles[pair] = series.map((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume]);
    market.push({ pair, price: series[series.length - 1].close, change: null, lastUpdated: series[series.length - 1].time });
    validation.push({ pair, candleCount: series.length, gaps, firstAt: series[0].time, lastAt: series[series.length - 1].time });
    console.log(`  ${series.length.toLocaleString('id-ID')} candle; ${gaps} gap besar.`);
  }

  const seed: FrozenSeed = {
    version: 1,
    frozen: { source: 'Indodax', startAt: START_AT, freezeAt: FREEZE_AT, forwardEndAt: FORWARD_END_AT, timeframe: TIMEFRAME, createdAt: new Date().toISOString(), pageLimit: 650 },
    candles,
    market,
    reports: {},
    snapshot: null,
    logs: [],
    validation
  };
  const root = process.cwd();
  const archiveDirectory = path.join(root, 'data');
  const publicDirectory = path.join(root, 'public', 'data');
  fs.mkdirSync(archiveDirectory, { recursive: true });
  fs.mkdirSync(publicDirectory, { recursive: true });
  const serialized = JSON.stringify(seed);
  fs.writeFileSync(path.join(archiveDirectory, 'indodax-frozen-2023-11-04_2026-11-04.json'), `${JSON.stringify(seed, null, 2)}\n`);
  fs.writeFileSync(path.join(publicDirectory, 'indodax-frozen.json'), `${serialized}\n`);

  const dashboardPath = path.join(publicDirectory, '..', 'dashboard.html');
  const dashboard = fs.readFileSync(dashboardPath, 'utf8');
  const embedded = dashboard.replace(/(<script id="offline-seed" type="application\/json">)[\s\S]*?(<\/script>)/, `$1${serialized}$2`);
  if (embedded === dashboard) throw new Error('Elemen offline-seed tidak ditemukan pada public/dashboard.html.');
  fs.writeFileSync(dashboardPath, embedded);
  console.log(`Dataset beku tersimpan: ${path.join(archiveDirectory, 'indodax-frozen-2023-11-04_2026-11-04.json')}`);
  console.log('Forward-test logs tidak dibuat ulang; laporan 4–14 Nov hanya dapat berasal dari log yang direkam saat periode berjalan.');
  return seed;
};

if (process.argv[1] && path.resolve(process.argv[1]).includes('freeze_offline_dataset')) {
  freezeOfflineDataset().catch((error) => {
    console.error('Freeze dataset gagal:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
