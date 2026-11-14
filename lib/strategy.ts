import type { Candle } from './indodax';

export type Signal = 'BUY' | 'SELL' | 'HOLD';

export type SignalResult = {
  signal: Signal;
  reason: string[];
  values: {
    longTrend: number;
    midTrend: number;
    fastTrend: number;
    breakoutHigh: number;
    breakoutLow: number;
    volumeAvg: number;
    momentum: number;
    atr: number;
  };
};

const ema = (values: number[], period: number) => {
  if (!values.length) return 0;
  if (period <= 1) return values[values.length - 1];

  const multiplier = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i += 1) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
};

const highest = (values: number[], period: number) => {
  if (!values.length) return 0;
  const start = Math.max(0, values.length - period);
  return Math.max(...values.slice(start));
};

const lowest = (values: number[], period: number) => {
  if (!values.length) return 0;
  const start = Math.max(0, values.length - period);
  return Math.min(...values.slice(start));
};

const atr = (candles: Candle[], period: number) => {
  if (candles.length < 2) return 0;

  const trValues: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trValues.push(tr);
  }

  return ema(trValues, period);
};

const roc = (values: number[], period: number) => {
  if (values.length <= period) return 0;
  const current = values[values.length - 1];
  const previous = values[values.length - 1 - period];
  if (previous === 0) return 0;
  return ((current - previous) / previous) * 100;
};

export const computeStrategySignal = (candles: Candle[]): SignalResult => {
  if (candles.length < 200) {
    return {
      signal: 'HOLD',
      reason: ['Data belum cukup untuk strategi trend breakout.'],
      values: {
        longTrend: 0,
        midTrend: 0,
        fastTrend: 0,
        breakoutHigh: 0,
        breakoutLow: 0,
        volumeAvg: 0,
        momentum: 0,
        atr: 0
      }
    };
  }

  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const volumes = candles.map((candle) => candle.volume);
  const priorHighs = highs.slice(0, -1);
  const priorLows = lows.slice(0, -1);
  const priorCloses = closes.slice(-41, -1);

  const longTrend = ema(closes, 200);
  const midTrend = ema(closes, 50);
  const fastTrend = ema(closes, 20);
  const breakoutHigh = highest(priorHighs, 40);
  const breakoutLow = lowest(priorLows, 40);
  const volumeAvg = ema(volumes.slice(-21, -1), 20);
  const momentum = roc(closes, 10);
  const atrValue = atr(candles, 14);

  const lastClose = closes[closes.length - 1];
  const lastVolume = volumes[volumes.length - 1];
  const priorHighestClose = Math.max(...priorCloses);

  const buyCondition =
    lastClose > longTrend &&
    midTrend > longTrend &&
    fastTrend > midTrend &&
    lastClose > breakoutHigh &&
    momentum > 0 &&
    lastVolume > volumeAvg;

  const sellCondition =
    lastClose < fastTrend ||
    lastClose < breakoutLow ||
    lastClose <= priorHighestClose - 2.2 * atrValue ||
    momentum < -5;

  if (buyCondition) {
    return {
      signal: 'BUY',
      reason: [
        'Trend jangka panjang bullish.',
        'EMA 20 > EMA 50 > EMA 200.',
        'Harga memecah level tertinggi 40 candle.',
        'Momentum positif dan volume mengonfirmasi.'
      ],
      values: {
        longTrend,
        midTrend,
        fastTrend,
        breakoutHigh,
        breakoutLow,
        volumeAvg,
        momentum,
        atr: atrValue
      }
    };
  }

  if (sellCondition) {
    return {
      signal: 'SELL',
      reason: [
        'Trend melemah atau harga turun di bawah moving average.',
        'Breakdown terjadi dan momentum negatif.',
        'Trailing stop berbasis ATR terpicu.'
      ],
      values: {
        longTrend,
        midTrend,
        fastTrend,
        breakoutHigh,
        breakoutLow,
        volumeAvg,
        momentum,
        atr: atrValue
      }
    };
  }

  return {
    signal: 'HOLD',
    reason: ['Tidak ada konfirmasi sinyal kuat untuk entry atau exit.'],
    values: {
      longTrend,
      midTrend,
      fastTrend,
      breakoutHigh,
      breakoutLow,
      volumeAvg,
      momentum,
      atr: atrValue
    }
  };
};
