import { DEFAULT_UNIVERSE, type Candle } from './indodax';
import { INITIAL_CAPITAL, MIN_ORDER_IDR } from './risk';

export type OrderSide = 'BUY' | 'SELL';

export type DepthLevel = {
  price: number;
  volume: number;
};

export type FillResult = {
  executedQty: number;
  avgFillPrice: number;
  notionalIdr: number;
  fee: number;
  feeRate: number;
  remainingQty: number;
};

export const TAKER_FEE_RATE = 0.0015; // 0.15% suku bunga taker all-in; sesuaikan bila dibutuhkan

export const getPairPriceIncrement = (pair: string) => {
  const normalized = pair.toUpperCase();
  if (normalized.includes('BTC')) return 1000;
  if (normalized.includes('ETH')) return 100;
  if (normalized.includes('SOL')) return 10;
  if (normalized.includes('BNB')) return 10;
  if (normalized.includes('XRP')) return 1;
  if (normalized.includes('ADA')) return 1;
  return 1;
};

export const roundToIncrement = (value: number, pair: string) => {
  const increment = getPairPriceIncrement(pair);
  return Math.round(value / increment) * increment;
};

export const normalizeQty = (qty: number) => {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  return Number(qty.toFixed(6));
};

export const calculateNotional = (qty: number, price: number) => qty * price;

export const getFee = (notional: number, feeRate = TAKER_FEE_RATE) => notional * feeRate;

export const calculateMarketFill = (
  side: OrderSide,
  pair: string,
  quantity: number,
  levels: DepthLevel[]
): FillResult => {
  const normalizedQty = normalizeQty(quantity);
  if (!normalizedQty) {
    return {
      executedQty: 0,
      avgFillPrice: 0,
      notionalIdr: 0,
      fee: 0,
      feeRate: TAKER_FEE_RATE,
      remainingQty: 0
    };
  }

  let remaining = normalizedQty;
  let totalCost = 0;
  let consumed = 0;

  const orderedLevels = [...levels].sort((a, b) => (side === 'BUY' ? a.price - b.price : b.price - a.price));

  for (const level of orderedLevels) {
    if (remaining <= 0) break;
    const takeQty = Math.min(level.volume, remaining);
    const fillPrice = level.price;
    totalCost += takeQty * fillPrice;
    consumed += takeQty;
    remaining -= takeQty;
  }

  const avgFillPrice = consumed > 0 ? totalCost / consumed : 0;
  const notionalIdr = consumed > 0 ? totalCost : 0;
  const fee = getFee(notionalIdr);

  return {
    executedQty: consumed,
    avgFillPrice,
    notionalIdr,
    fee,
    feeRate: TAKER_FEE_RATE,
    remainingQty: remaining
  };
};

export const ensureValidOrder = (pair: string, side: OrderSide, quantity: number, orderBook: { bestAsk: number; bestBid: number; asks: DepthLevel[]; bids: DepthLevel[] }) => {
  const limit = Math.max(MIN_ORDER_IDR, 25000);
  const baseQty = normalizeQty(quantity);

  if (!baseQty) {
    return { valid: false, reason: 'Kuantitas order tidak valid.' };
  }

  if (side === 'BUY') {
    const notional = baseQty * orderBook.bestAsk;
    if (notional < limit) {
      return { valid: false, reason: `Notional order di bawah batas minimum Rp${limit}.` };
    }
  }

  if (side === 'SELL') {
    const notional = baseQty * orderBook.bestBid;
    if (notional < limit) {
      return { valid: false, reason: `Notional order di bawah batas minimum Rp${limit}.` };
    }
  }

  if (!orderBook.asks.length || !orderBook.bids.length) {
    return { valid: false, reason: 'Order book kosong.' };
  }

  return { valid: true, reason: 'OK' };
};

export const estimatePositionSize = (capital: number, pair: string) => {
  const maxSize = capital * 0.2;
  const price = getPairPriceIncrement(pair);
  return Math.max(0, maxSize / price);
};

export const simulateDryRunOrder = (
  pair: string,
  side: OrderSide,
  quantity: number,
  orderBook: { asks: DepthLevel[]; bids: DepthLevel[]; bestAsk: number; bestBid: number }
) => {
  const levelSource = side === 'BUY' ? orderBook.asks : orderBook.bids;
  const fill = calculateMarketFill(side, pair, quantity, levelSource);
  const status = fill.executedQty <= 0
    ? 'REJECTED'
    : fill.remainingQty > 1e-8
      ? 'PARTIAL'
      : 'FILLED';

  if (side === 'BUY') {
    return {
      side,
      pair,
      quantity: fill.executedQty,
      avgPrice: fill.avgFillPrice,
      notional: fill.notionalIdr,
      fee: fill.fee,
      remainingQty: fill.remainingQty,
      status
    };
  }

  return {
    side,
    pair,
    quantity: fill.executedQty,
    avgPrice: fill.avgFillPrice,
    notional: fill.notionalIdr,
    fee: fill.fee,
    remainingQty: fill.remainingQty,
    status
  };
};

export const buildSignalPayload = (candles: Candle[]) => {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const highestClose = Math.max(...closes);
  const lowestClose = Math.min(...closes);
  const avgVolume = volumes.reduce((sum, vol) => sum + vol, 0) / Math.max(1, volumes.length);

  return {
    closes,
    volumes,
    highestClose,
    lowestClose,
    avgVolume
  };
};

export const isValidUniverse = (pair: string) => DEFAULT_UNIVERSE.includes(pair as any);
