// server.js — zero-dependency HTTP server.
// Serves the static frontend and a small JSON API backed by db.js.

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const quotes = require('./quotes');
const universe = require('./universe');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 4178;

// Load .env (simple parser, no dotenv dependency) before db.js reads it.
// Note: db.js is required above, so env must be loaded first — see start.sh,
// which loads .env into the process environment before launching node.

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function handleApi(req, res, url) {
  // GET /api/state  -> { positions, notes }
  if (url === '/api/state' && req.method === 'GET') {
    return send(res, 200, await db.getState());
  }
  // PUT /api/state  -> replace whole document
  if (url === '/api/state' && req.method === 'PUT') {
    const body = await readBody(req);
    const saved = await db.saveState({
      positions: Array.isArray(body.positions) ? body.positions : [],
      notes: Array.isArray(body.notes) ? body.notes : [],
    });
    return send(res, 200, saved);
  }
  if (url === '/api/health') {
    return send(res, 200, { ok: true, backend: db.kind, quotes: quotes.enabled(), cached: quotes.count() });
  }
  // GET /api/symbols  -> the searchable stock library (with index tags)
  if (url.startsWith('/api/symbols') && req.method === 'GET') {
    return send(res, 200, { count: universe.count(), symbols: universe.all() });
  }
  // GET /api/quotes?symbols=AAPL,MSFT  (omit symbols for the whole snapshot)
  if (url.startsWith('/api/quotes') && req.method === 'GET') {
    const q = new URL(url, 'http://x').searchParams.get('symbols');
    const list = q ? q.split(',').map((s) => s.trim()).filter(Boolean) : null;
    return send(res, 200, { enabled: quotes.enabled(), count: quotes.count(), quotes: quotes.snapshot(list) });
  }
  // GET /api/stock/AAPL  -> quote + profile for the detail panel
  if (url.startsWith('/api/stock/') && req.method === 'GET') {
    const symbol = decodeURIComponent(url.slice('/api/stock/'.length).split('?')[0]).toUpperCase();
    const profile = await quotes.getProfile(symbol);
    return send(res, 200, { symbol, quote: quotes.one(symbol), profile });
  }
  return send(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let rel = url === '/' ? '/index.html' : url;
  rel = rel.split('?')[0];
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');

  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(filePath)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  try {
    if (url.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, async () => {
  console.log(`[server] http://localhost:${PORT}  (db: ${db.kind})`);
  // Refresh the stock list first (one call, only if >7 days old), THEN start
  // the quote loop — otherwise the loop would starve the refresh of its call.
  await universe.ensureFresh();
  quotes.start(); // begins background fetch only if FINNHUB_KEY is set

  // Re-check the stock list once a day; ensureFresh only re-pulls when the file
  // is >7 days old. Pause the quote loop during the check so its one call gets
  // through the rate limit.
  setInterval(async () => {
    quotes.pause();
    try {
      await universe.ensureFresh();
    } finally {
      quotes.resume();
    }
  }, 24 * 60 * 60 * 1000);
});
