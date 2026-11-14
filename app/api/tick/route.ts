import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_UNIVERSE, fetchIndodaxHistory, fetchOrderBook, summarizeValidation, TIMEFRAME_SECONDS, validateOrderBook } from '@/lib/indodax';
import { computeStrategySignal } from '@/lib/strategy';
import { canOpenNewPosition, ensureDailyReset, getDefaultPortfolioState, getMaxPositionSize, getWibDateKey, isDailyLossLimitReached } from '@/lib/risk';
import { ensureValidOrder, simulateDryRunOrder, TAKER_FEE_RATE } from '@/lib/execution';
import { readStoredJson, writeStoredJson } from '@/lib/storage';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  let pair = 'unknown';
  try {
    const body = await request.json().catch(() => ({}));
    const secretHeader = request.headers.get('x-cron-secret') ?? request.headers.get('authorization') ?? '';
    const configuredSecret = process.env.CRON_SECRET;
    if (!configuredSecret && process.env.NODE_ENV === 'production') {
      return NextResponse.json({ ok: false, message: 'CRON_SECRET is not configured' }, { status: 503 });
    }
    const expectedSecret = configuredSecret ?? 'dev-secret';
    const providedSecret = secretHeader.replace('Bearer ', '').trim();

    if (providedSecret !== expectedSecret) {
      return NextResponse.json({ ok: false, message: 'Forbidden: CRON_SECRET invalid' }, { status: 401 });
    }

    const defaultPair = body.pair ?? DEFAULT_UNIVERSE[0];
    const stored = (await readStoredJson('indodax-dryrun-state')) ?? { state: getDefaultPortfolioState(), logs: [] };
    const portfolio = ensureDailyReset(stored.state ?? getDefaultPortfolioState());
    const logs = Array.isArray(stored.logs) ? stored.logs : [];
    pair = DEFAULT_UNIVERSE.includes(defaultPair as any) ? defaultPair : DEFAULT_UNIVERSE[0];

    const now = Math.floor(Date.now() / 1000);
    const from = now - 300 * TIMEFRAME_SECONDS['1h'];
    const { candles, issues } = await fetchIndodaxHistory(pair, '1h', from, now);

    if (candles.length < 200) {
      const message = `Butuh minimal 200 candle tertutup untuk menghitung sinyal; tersedia ${candles.length}.`;
      const event = { type: 'validation_error', pair, timestamp: new Date().toISOString(), issues, message, candlesCount: candles.length };
      await writeStoredJson({ state: portfolio, logs: [...logs, event] }, 'indodax-dryrun-state');
      return NextResponse.json({ ok: false, pair, message, issues }, { status: 400 });
    }

    const signal = computeStrategySignal(candles);
    const orderBook = await fetchOrderBook(pair);
    const orderBookIssues = validateOrderBook(pair, orderBook);
    const allIssues = [...issues, ...orderBookIssues];
    const summary = summarizeValidation(allIssues);

    if (!summary.ok) {
      const event = {
        type: 'validation_error', pair, timestamp: new Date().toISOString(),
        signal: signal.signal, signalReasons: signal.reason, issues: allIssues,
        candlesCount: candles.length,
        orderBook: { bestBid: orderBook.bestBid, bestAsk: orderBook.bestAsk, spreadPercent: orderBook.spreadPercent, bids: orderBook.bids.slice(0, 5), asks: orderBook.asks.slice(0, 5) }
      };
      await writeStoredJson({ state: portfolio, logs: [...logs, event] }, 'indodax-dryrun-state');

      return NextResponse.json({ ok: false, pair, signal: signal.signal, summary, issues: allIssues }, { status: 400 });
    }

    const lastCandleTime = candles[candles.length - 1].time;
    if (portfolio.lastProcessedCandle?.[pair] === lastCandleTime) {
      const event = { type: 'tick_run', pair, timestamp: new Date().toISOString(), signal: signal.signal, signalReasons: signal.reason, duplicate: true, candlesCount: candles.length };
      await writeStoredJson({ state: portfolio, logs: [...logs, event] }, 'indodax-dryrun-state');
      return NextResponse.json({ ok: true, duplicate: true, pair, signal: signal.signal, message: 'Candle already processed.' }, { status: 200 });
    }

    let orderResult = null;
    let riskReason: string | null = null;
    let cash = portfolio.capital;
    let dailyPnL = portfolio.dailyPnL;
    let positions = [...portfolio.positions];

    if (signal.signal === 'BUY') {
      if (positions.some((position) => position.pair === pair)) {
        riskReason = 'Posisi untuk pair ini sudah terbuka.';
      } else if (!canOpenNewPosition(portfolio) || isDailyLossLimitReached(portfolio)) {
        riskReason = portfolio.killSwitch ? 'Kill switch aktif.' : isDailyLossLimitReached(portfolio) ? 'Daily loss limit tercapai.' : 'Batas jumlah posisi tercapai.';
      } else {
        const maxNotional = Math.min(getMaxPositionSize(), cash / (1 + TAKER_FEE_RATE));
        const quantity = Number((maxNotional / orderBook.bestAsk).toFixed(6));
        const orderCheck = ensureValidOrder(pair, 'BUY', quantity, orderBook);
        if (orderCheck.valid) {
          orderResult = simulateDryRunOrder(pair, 'BUY', quantity, orderBook);
          if (orderResult.status === 'FILLED' || orderResult.status === 'PARTIAL') {
            cash -= orderResult.notional + orderResult.fee;
            positions.push({
              pair,
              side: 'BUY',
              quantity: orderResult.quantity,
              avgPrice: orderResult.avgPrice,
              valueIdr: orderResult.quantity * orderBook.bestBid,
              entryCostIdr: orderResult.notional + orderResult.fee,
              openedAt: now
            });
          }
        } else {
          riskReason = orderCheck.reason;
        }
      }
    }

    if (signal.signal === 'SELL') {
      const positionIndex = positions.findIndex((position) => position.pair === pair);
      const position = positions[positionIndex];
      if (!position) {
        riskReason = 'Tidak ada posisi terbuka untuk ditutup.';
      } else {
        const orderCheck = ensureValidOrder(pair, 'SELL', position.quantity, orderBook);
      if (orderCheck.valid) {
          orderResult = simulateDryRunOrder(pair, 'SELL', position.quantity, orderBook);
          if (orderResult.status === 'FILLED' || orderResult.status === 'PARTIAL') {
            const soldQuantity = Math.min(orderResult.quantity, position.quantity);
            const ratioSold = soldQuantity / position.quantity;
            const costBasis = position.entryCostIdr ?? position.avgPrice * position.quantity;
            const soldCostBasis = costBasis * ratioSold;
            cash += orderResult.notional - orderResult.fee;
            dailyPnL += orderResult.notional - orderResult.fee - soldCostBasis;
            const remainingQuantity = position.quantity - soldQuantity;
            if (remainingQuantity <= 1e-8) positions.splice(positionIndex, 1);
            else positions[positionIndex] = {
              ...position,
              quantity: remainingQuantity,
              valueIdr: remainingQuantity * orderBook.bestBid,
              entryCostIdr: costBasis - soldCostBasis
            };
          }
        } else {
          riskReason = orderCheck.reason;
        }
      }
    }

    const nextState = {
      ...portfolio,
      capital: cash,
      dailyPnL,
      positions: positions.map((position) => position.pair === pair
        ? { ...position, valueIdr: position.quantity * orderBook.bestBid }
        : position),
      usedMargin: positions.reduce((total, position) => total + (position.entryCostIdr ?? position.valueIdr), 0),
      equity: cash + positions.reduce((total, position) => total + (position.pair === pair ? position.quantity * orderBook.bestBid : position.valueIdr), 0),
      lastProcessedCandle: {
        ...portfolio.lastProcessedCandle,
        [pair]: lastCandleTime
      },
      lastRunAt: Date.now(),
      lastDailyReset: getWibDateKey()
    };

    const payload = {
      state: nextState,
      logs: [
        ...logs,
        {
          type: 'tick_run',
          pair,
          timestamp: new Date().toISOString(),
          signal: signal.signal,
          signalReasons: signal.reason,
          orderResult,
          riskReason,
          dailyPnL,
          equity: nextState.equity,
          orderBook: { bestBid: orderBook.bestBid, bestAsk: orderBook.bestAsk, spreadPercent: orderBook.spreadPercent, bids: orderBook.bids.slice(0, 5), asks: orderBook.asks.slice(0, 5) },
          summary,
          candlesCount: candles.length
        }
      ]
    };

    await writeStoredJson(payload, 'indodax-dryrun-state');

    return NextResponse.json({
      ok: true,
      pair,
      signal: signal.signal,
      orderResult,
      summary,
      processedAt: new Date().toISOString()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    try {
      const current = await readStoredJson('indodax-dryrun-state');
      await writeStoredJson({
        state: current?.state ?? getDefaultPortfolioState(),
        logs: [...(Array.isArray(current?.logs) ? current.logs : []), {
          type: 'runtime_error',
          pair,
          timestamp: new Date().toISOString(),
          message
        }]
      }, 'indodax-dryrun-state');
    } catch (logError) {
      console.error('Gagal menyimpan runtime error ke storage:', logError);
    }
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: 'Tick endpoint is active.' });
}
