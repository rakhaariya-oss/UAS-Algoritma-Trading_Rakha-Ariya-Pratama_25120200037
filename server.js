const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
const PAIRS = ['BTC/IDR', 'ETH/IDR', 'SOL/IDR', 'BNB/IDR', 'XRP/IDR', 'ADA/IDR', 'DOGE/IDR'];
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

async function handleMarketRequest() {
  const response = await fetch('https://indodax.com/api/ticker_all', {
    headers: { Accept: 'application/json', 'User-Agent': 'Indodax-DryRun/1.0' },
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`Indodax market data unavailable: ${response.status}`);
  }

  const payload = await response.json();
  const tickers = payload?.tickers ?? payload?.ticker ?? {};
  const data = PAIRS.map((pair) => {
    const ticker = tickers[pair.replace('/', '').toLowerCase()];
    const price = Number(ticker?.last);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Indodax ticker unavailable for ${pair}`);
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

  return {
    source: 'indodax',
    generatedAt: new Date().toISOString(),
    data
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function serveStaticFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeTypes[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': mime,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (url.pathname === '/api/market') {
    try {
      const payload = await handleMarketRequest();
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || 'Internal server error'
      });
    }
    return;
  }

  const isDashboardPage = ['/', '/dashboard.html', '/dashboard-live.html'].includes(url.pathname);
  let filePath = isDashboardPage
    ? path.join(ROOT, 'public', 'dashboard.html')
    : path.join(ROOT, url.pathname);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    serveStaticFile(res, path.join(ROOT, 'index.html'));
    return;
  }

  serveStaticFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`Local dashboard running at http://127.0.0.1:${PORT}`);
});
