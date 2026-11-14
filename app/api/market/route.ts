import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAIRS = ['BTC/IDR', 'ETH/IDR', 'SOL/IDR', 'BNB/IDR', 'XRP/IDR', 'ADA/IDR', 'DOGE/IDR'] as const;

export async function GET() {
  try {
    const response = await fetch('https://indodax.com/api/ticker_all', {
      headers: { Accept: 'application/json', 'User-Agent': 'Indodax-DryRun/1.0' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      return NextResponse.json({ ok: false, source: 'indodax', error: `Indodax API returned ${response.status}` }, { status: 502 });
    }

    const payload = await response.json();
    const tickers = payload?.tickers ?? payload?.ticker ?? {};
    const data = PAIRS.map((pair) => {
      const symbol = pair.replace('/', '_').toLowerCase();
      const ticker = tickers[symbol] ?? tickers[pair.replace('/', '').toLowerCase()];
      const price = Number(ticker?.last);
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Indodax ticker is missing or invalid for ${pair}`);
      }

      const change = Number(ticker.changes ?? ticker.change);
      return {
        pair,
        price,
        high: Number(ticker.high) || null,
        low: Number(ticker.low) || null,
        change: Number.isFinite(change) ? change : null,
        volume: Number(ticker.vol_idr) || null,
        buy: Number(ticker.buy) || null,
        sell: Number(ticker.sell) || null,
        lastUpdated: new Date(Number(ticker.server_time) * 1000 || Date.now()).toISOString()
      };
    });

    return NextResponse.json({
      ok: true,
      source: 'indodax',
      generatedAt: new Date().toISOString(),
      data
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Indodax market data unavailable';
    return NextResponse.json({ ok: false, source: 'indodax', error: message }, { status: 502 });
  }
}
