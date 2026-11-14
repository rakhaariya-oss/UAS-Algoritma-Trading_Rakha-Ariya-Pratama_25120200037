import assert from 'node:assert/strict';
import { FREEZE_AT, FORWARD_END_AT, getForwardWindowEndMs } from './backtest';

assert.equal(FREEZE_AT, '2026-11-04T05:00:00.000Z');
assert.equal(FORWARD_END_AT, '2026-11-14T05:00:00.000Z');
assert.ok(new Date(FORWARD_END_AT).getTime() > new Date(FREEZE_AT).getTime());
assert.equal(getForwardWindowEndMs(Date.parse('2026-11-13T22:28:00.000Z')), Date.parse('2026-11-13T22:00:00.000Z'));
assert.equal(getForwardWindowEndMs(Date.parse('2026-11-14T12:28:00.000Z')), Date.parse(FORWARD_END_AT));

console.log('freeze dates OK');
