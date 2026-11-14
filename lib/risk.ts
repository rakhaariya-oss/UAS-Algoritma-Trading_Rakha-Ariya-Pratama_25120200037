import { DEFAULT_UNIVERSE } from './indodax';

export const INITIAL_CAPITAL = 100_000_000;
export const DAILY_LOSS_LIMIT_PERCENT = 0.12;
export const MAX_POSITIONS = 3;
export const MAX_POSITION_SIZE_PERCENT = 0.2;
export const MIN_ORDER_IDR = 25_000;

export type PositionState = {
  pair: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  avgPrice: number;
  valueIdr: number;
  entryCostIdr?: number;
  openedAt: number;
};

export type PortfolioState = {
  capital: number;
  equity: number;
  usedMargin: number;
  dailyPnL: number;
  positions: PositionState[];
  lastProcessedCandle: Record<string, number>;
  lastRunAt: number;
  killSwitch: boolean;
  lastDailyReset: string;
};

export const formatIdr = (value: number) =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(value);

export const getDailyLossLimit = () => INITIAL_CAPITAL * DAILY_LOSS_LIMIT_PERCENT;

export const getMaxPositionSize = () => INITIAL_CAPITAL * MAX_POSITION_SIZE_PERCENT;

export const getRiskBudget = () => ({
  capital: INITIAL_CAPITAL,
  maxPositions: MAX_POSITIONS,
  maxPositionSize: getMaxPositionSize(),
  dailyLossLimit: getDailyLossLimit()
});

export const isDailyLossLimitReached = (state: PortfolioState) => {
  return state.dailyPnL <= -getDailyLossLimit();
};

export const canOpenNewPosition = (state: PortfolioState) => {
  if (state.killSwitch) return false;
  if (isDailyLossLimitReached(state)) return false;
  if (state.positions.length >= MAX_POSITIONS) return false;
  return true;
};

export const getWibDateKey = (date = new Date()) => {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const wib = new Date(utc + 7 * 60 * 60 * 1000);
  return wib.toISOString().slice(0, 10);
};

export const ensureDailyReset = (state: PortfolioState) => {
  const todayKey = getWibDateKey();

  if (state.lastDailyReset !== todayKey) {
    return {
      ...state,
      dailyPnL: 0,
      lastDailyReset: todayKey
    };
  }

  return state;
};

export const getDefaultPortfolioState = (): PortfolioState => ({
  capital: INITIAL_CAPITAL,
  equity: INITIAL_CAPITAL,
  usedMargin: 0,
  dailyPnL: 0,
  positions: [],
  lastProcessedCandle: Object.fromEntries(DEFAULT_UNIVERSE.map((pair) => [pair, 0])),
  lastRunAt: Date.now(),
  killSwitch: false,
  lastDailyReset: getWibDateKey()
});
