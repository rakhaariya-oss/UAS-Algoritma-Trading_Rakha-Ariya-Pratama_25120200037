export type Timeframe = '15m' | '1h' | '4h' | '1d';

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
};

export type ValidationIssue = {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  pair: string;
  candleTime?: number;
};

export type DepthLevel = {
  price: number;
  volume: number;
};

export const DEFAULT_UNIVERSE = [
  'BTC/IDR',
  'ETH/IDR',
  'SOL/IDR',
  'BNB/IDR',
  'XRP/IDR',
  'ADA/IDR',
  'DOGE/IDR'
] as const;

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60
};

const INODAX_TIMEFRAME: Record<Timeframe, string> = {
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': '1D'
};

const toNumber = (value: unknown): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const mean = (values: number[]) => {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const priceIsValid = (value: number) => Number.isFinite(value) && value > 0;
const volumeIsValid = (value: number) => Number.isFinite(value) && value >= 0;

const normalizeBar = (raw: any): Candle | null => {
  if (!raw) return null;

  const time = toNumber(raw.time ?? raw.Time ?? raw[0] ?? raw.timestamp ?? raw.t);
  const open = toNumber(raw.open ?? raw.Open ?? raw[1] ?? raw.o);
  const high = toNumber(raw.high ?? raw.High ?? raw[2] ?? raw.h);
  const low = toNumber(raw.low ?? raw.Low ?? raw[3] ?? raw.l);
  const close = toNumber(raw.close ?? raw.Close ?? raw[4] ?? raw.c);
  const volume = toNumber(raw.volume ?? raw.Volume ?? raw[5] ?? raw.v);

  if (!time || !priceIsValid(open) || !priceIsValid(high) || !priceIsValid(low) || !priceIsValid(close)) {
    return null;
  }

  if (!volumeIsValid(volume)) return null;

  return {
    time,
    open,
    high,
    low,
    close,
    volume,
    isClosed: true
  };
};

export const buildHistoryUrl = (pair: string, tf: Timeframe, from: number, to: number) => {
  const symbol = pair.replace('/', '').toUpperCase();
  const timeframe = INODAX_TIMEFRAME[tf];
  return `https://indodax.com/tradingview/history_v2?symbol=${symbol}&tf=${timeframe}&from=${from}&to=${to}`;
};

export const fetchIndodaxHistory = async (
  pair: string,
  tf: Timeframe,
  from: number,
  to: number
): Promise<{ candles: Candle[]; issues: ValidationIssue[]; serverTime: number }> => {
  const issues: ValidationIssue[] = [];
  const url = buildHistoryUrl(pair, tf, from, to);

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Indodax-DryRun/1.0'
    },
    cache: 'no-store'
  });

  if (!response.ok) {
    issues.push({
      code: 'FETCH_ERROR',
      message: `Gagal mengambil data sejarah dari Indodax (${response.status}) untuk ${pair}`,
      severity: 'error',
      pair
    });
    return { candles: [], issues, serverTime: Math.floor(Date.now() / 1000) };
  }

  const payload = await response.json();
  const rawCandles = Array.isArray(payload) ? payload : payload?.data ?? payload?.candles ?? [];

  const candles: Candle[] = rawCandles
    .map((item: any) => normalizeBar(item))
    .filter((item: Candle | null): item is Candle => item !== null);

  if (!candles.length) {
    issues.push({
      code: 'EMPTY_DATA',
      message: `Data candle kosong untuk ${pair}`,
      severity: 'error',
      pair
    });
    return { candles: [], issues, serverTime: Math.floor(Date.now() / 1000) };
  }

  const serverTime = Math.floor(Date.now() / 1000);
  const lastCandle = candles[candles.length - 1];
  const tfSeconds = TIMEFRAME_SECONDS[tf];

  if (lastCandle.time + tfSeconds > serverTime) {
    issues.push({
      code: 'RUNNING_CANDLE',
      message: `Bar terakhir masih berjalan untuk ${pair}. Dibuang agar tidak terjadi look-ahead bias.`,
      severity: 'warning',
      pair,
      candleTime: lastCandle.time
    });
  }

  for (let i = 1; i < candles.length; i += 1) {
    const previous = candles[i - 1];
    const current = candles[i];
    const expectedGap = tfSeconds;
    const actualGap = current.time - previous.time;

    if (actualGap > expectedGap * 2) {
      issues.push({
        code: 'GAP_DETECTED',
        message: `Candle hilang pada ${pair} pada jendela ${current.time}. Gap mendadak: ${actualGap}s.`,
        severity: 'error',
        pair,
        candleTime: current.time
      });
    }

    if (current.volume <= 0 || current.open <= 0 || current.close <= 0) {
      issues.push({
        code: 'ZERO_OR_INVALID_PRICE',
        message: `Volume atau harga nol pada candle ${pair} di ${current.time}.`,
        severity: 'error',
        pair,
        candleTime: current.time
      });
    }

    if (current.high < Math.max(current.open, current.close) || current.low > Math.min(current.open, current.close)) {
      issues.push({
        code: 'INVALID_CANDLE_SHAPE',
        message: `Struktur candle tidak valid untuk ${pair} di ${current.time}.`,
        severity: 'error',
        pair,
        candleTime: current.time
      });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const oldestAllowed = now - tfSeconds * 2;

  if (lastCandle.time < oldestAllowed) {
    issues.push({
      code: 'STALE_WINDOW',
      message: `Candle tertutup terakhir lebih tua dari 2x timeframe untuk ${pair}.`,
      severity: 'error',
      pair,
      candleTime: candles[0].time
    });
  }

  const cleanedCandles = candles.filter((candle) => {
    const isRunning = candle.time + tfSeconds > serverTime;
    return !isRunning;
  });

  return {
    candles: cleanedCandles,
    issues,
    serverTime
  };
};

export const fetchOrderBook = async (pair: string) => {
  const symbol = pair.replace('/', '').toLowerCase();
  const url = `https://indodax.com/api/depth/${symbol}`;

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Indodax-DryRun/1.0'
    },
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`Order book gagal diambil untuk ${pair}: ${response.status}`);
  }

  const payload = await response.json();
  const rawAsks = payload?.asks ?? payload?.sell ?? [];
  const rawBids = payload?.bids ?? payload?.buy ?? [];

  const asks = rawAsks.map((item: any) => ({
    price: toNumber(Array.isArray(item) ? item[0] : item?.price),
    volume: toNumber(Array.isArray(item) ? item[1] : item?.volume)
  }));

  const bids = rawBids.map((item: any) => ({
    price: toNumber(Array.isArray(item) ? item[0] : item?.price),
    volume: toNumber(Array.isArray(item) ? item[1] : item?.volume)
  }));

  const bestAsk = asks[0]?.price ?? 0;
  const bestBid = bids[0]?.price ?? 0;
  const spreadPercent = bestAsk && bestBid ? ((bestAsk - bestBid) / bestBid) * 100 : 0;

  return {
    asks,
    bids,
    bestAsk,
    bestBid,
    spreadPercent,
    valid: asks.length > 0 && bids.length > 0 && spreadPercent <= 2
  };
};

export const validateOrderBook = (pair: string, orderBook: Awaited<ReturnType<typeof fetchOrderBook>>) => {
  const issues: ValidationIssue[] = [];

  if (!orderBook.valid) {
    issues.push({
      code: 'INVALID_ORDERBOOK',
      message: `Order book ${pair} tidak valid: spread terlalu lebar atau order book kosong.`,
      severity: 'error',
      pair
    });
  }

  if (orderBook.bestAsk <= 0 || orderBook.bestBid <= 0) {
    issues.push({
      code: 'MISSING_BEST_PRICE',
      message: `Best bid/ask tidak tersedia untuk ${pair}.`,
      severity: 'error',
      pair
    });
  }

  return issues;
};

export const summarizeValidation = (issues: ValidationIssue[]) => {
  const errors = issues.filter((item) => item.severity === 'error').length;
  const warnings = issues.filter((item) => item.severity === 'warning').length;

  return {
    ok: errors === 0,
    errors,
    warnings,
    issues
  };
};

export const calculateAveragePriceFromLevels = (levels: DepthLevel[], desiredQty: number) => {
  if (!levels.length || desiredQty <= 0) return 0;

  let remaining = desiredQty;
  let totalCost = 0;
  let consumed = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(level.volume, remaining);
    totalCost += take * level.price;
    consumed += take;
    remaining -= take;
  }

  return consumed > 0 ? totalCost / consumed : 0;
};

export const getWibNow = () => {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + 7 * 60 * 60 * 1000);
};

export const validateCandleWindow = (candles: Candle[], pair: string) => {
  const issues: ValidationIssue[] = [];
  const serverTime = Math.floor(Date.now() / 1000);

  if (!candles.length) {
    issues.push({
      code: 'NO_HISTORY',
      message: `Tidak ada candle valid untuk ${pair}.`,
      severity: 'error',
      pair
    });
    return issues;
  }

  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1];
    const curr = candles[i];

    if (curr.time <= prev.time) {
      issues.push({
        code: 'UNSORTED_CANDLES',
        message: `Candle tidak berurutan untuk ${pair}.`,
        severity: 'error',
        pair,
        candleTime: curr.time
      });
    }

    if (curr.volume <= 0 || curr.open <= 0 || curr.close <= 0 || curr.high <= 0 || curr.low <= 0) {
      issues.push({
        code: 'ZERO_VALUE',
        message: `Ada nilai nol pada candle ${pair}.`,
        severity: 'error',
        pair,
        candleTime: curr.time
      });
    }
  }

  const last = candles[candles.length - 1];
  if (last.time + TIMEFRAME_SECONDS['1h'] > serverTime) {
    issues.push({
      code: 'RECENT_CANDLE',
      message: `Bar terakhir masih terlalu baru untuk ${pair}; data belum lengkap untuk diproses.`,
      severity: 'warning',
      pair,
      candleTime: last.time
    });
  }

  const closes = candles.map((candle) => candle.close);
  const avgClose = mean(closes);
  if (!avgClose) {
    issues.push({
      code: 'INVALID_AVERAGE',
      message: `Rata-rata close tidak valid untuk ${pair}.`,
      severity: 'error',
      pair
    });
  }

  return issues;
};
