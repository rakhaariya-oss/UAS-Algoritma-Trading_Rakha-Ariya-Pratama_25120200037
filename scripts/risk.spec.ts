import assert from 'node:assert/strict';
import { simulateDryRunOrder } from '../lib/execution';
import { ensureDailyReset, getDefaultPortfolioState } from '../lib/risk';

const openPosition = {
  pair: 'BTC/IDR',
  side: 'BUY' as const,
  quantity: 0.01,
  avgPrice: 1_000_000_000,
  valueIdr: 10_000_000,
  entryCostIdr: 10_015_000,
  openedAt: 1_800_000_000
};
const resetState = ensureDailyReset({
  ...getDefaultPortfolioState(),
  dailyPnL: -500_000,
  lastDailyReset: '2000-01-01',
  positions: [openPosition]
});
assert.equal(resetState.dailyPnL, 0);
assert.deepEqual(resetState.positions, [openPosition]);

const partialOrder = simulateDryRunOrder('BTC/IDR', 'BUY', 1, {
  asks: [{ price: 100, volume: 0.4 }],
  bids: [{ price: 99, volume: 1 }],
  bestAsk: 100,
  bestBid: 99
});
assert.equal(partialOrder.status, 'PARTIAL');
assert.equal(partialOrder.quantity, 0.4);
assert.equal(partialOrder.remainingQty, 0.6);

console.log('risk and partial-fill checks OK');
