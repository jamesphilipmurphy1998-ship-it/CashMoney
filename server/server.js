// server.js — zero-dependency HTTP server.
// Serves the static frontend and a small JSON API backed by db.js.

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const quotes = require('./quotes');
const yahoo = require('./yahoo');
const universe = require('./universe');
const history = require('./history');
const sharesies = require('./sharesies');
const yahooFinancials = require('./yahoo-financials');
const financialsSweep = require('./financials-sweep');
const yahooNews = require('./yahoo-news');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 4178;

// Verifies a Supabase access token by asking Supabase's own auth server who
// it belongs to — this is what makes the Sharesies per-user isolation
// (server/sharesies.js) actually hold against a malicious client, not just
// an accidental one. A client can no longer just claim to be any uid it
// likes via a plain header; it must present a token Supabase itself will
// vouch for, and we use the id *Supabase* returns, not anything the client
// sent. Returns the verified user id, or null if the token is missing/bad.
async function verifyUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const user = await r.json();
    return user?.id || null;
  } catch {
    return null;
  }
}

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
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  // GET /api/ticker?symbols=SPY,QQQ  -> quotes for the market-ticker strip,
  // registering any new symbols so they get priced and kept fresh.
  if (url.startsWith('/api/ticker') && req.method === 'GET') {
    const q = new URL(url, 'http://x').searchParams.get('symbols');
    const list = q ? q.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
    if (list.length) quotes.ensureWatched(list);
    // Strip symbols Finnhub can't price (index/spot symbols like ^FTSE, GC=F,
    // or non-US listings) get pulled from Yahoo on demand so the strip stays
    // live. Finnhub-priced ones are skipped (already fresh in the cache).
    const needYahoo = list.filter((s) => { const c = quotes.one(s); return !c || c.source === 'yahoo'; });
    if (needYahoo.length) await Promise.all(needYahoo.map((s) => yahoo.fetchNow(s).catch(() => {})));
    return send(res, 200, { enabled: quotes.enabled(), quotes: quotes.snapshot(list) });
  }
  // GET /api/movers  -> biggest daily gainers/losers from the priced cache
  // (stocks only — indices/FX/futures excluded). Names are attached client-side.
  if (url.startsWith('/api/movers') && req.method === 'GET') {
    const snap = quotes.snapshot(null);
    const members = universe.tagged(); // real index constituents only
    const items = [];
    for (const s in snap) {
      if (!members.has(s)) continue; // skip non-index / illiquid junk
      const d = snap[s].day;
      // Guard against bad prevClose data producing absurd % moves.
      if (typeof d === 'number' && d !== 0 && Math.abs(d) < 60) items.push({ s, d, price: snap[s].price, open: snap[s].open || 0 });
    }
    items.sort((a, b) => b.d - a.d);
    return send(res, 200, { gainers: items.slice(0, 20), losers: items.slice(-20).reverse() });
  }
  // GET /api/peek?symbols=AAPL,MSFT  -> read-only prices for the search
  // dropdown. Unlike /api/quotes it does NOT promote symbols to the Finnhub
  // hot set; it just returns the cache and fills any gaps from Yahoo on demand.
  if (url.startsWith('/api/peek') && req.method === 'GET') {
    const q = new URL(url, 'http://x').searchParams.get('symbols');
    const list = q ? q.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
    const missing = list.filter((s) => !quotes.one(s));
    if (missing.length) await Promise.all(missing.map((s) => yahoo.fetchNow(s).catch(() => {})));
    return send(res, 200, { quotes: quotes.snapshot(list) });
  }
  // GET /api/logos?symbols=AAPL,MSFT  -> { AAPL: 'https://...logo.png', ... }.
  // Same cached Finnhub profile /api/stock's `profile.logo` field uses, just
  // batched and without the quote/metrics fetch — cheap enough to call for
  // every row in the holdings table (see the mini logo next to each ticker).
  if (url.startsWith('/api/logos') && req.method === 'GET') {
    const q = new URL(url, 'http://x').searchParams.get('symbols');
    const list = q ? q.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
    const out = {};
    await Promise.all(list.map(async (s) => {
      const p = await quotes.getProfile(s);
      if (p && p.logo) out[s] = p.logo;
    }));
    return send(res, 200, out);
  }
  // GET /api/quotes?symbols=AAPL,MSFT  (omit symbols for the whole snapshot)
  if (url.startsWith('/api/quotes') && req.method === 'GET') {
    const params = new URL(url, 'http://x').searchParams;
    const q = params.get('symbols');
    const list = q ? q.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
    // A user's own pasted Finnhub key (Connectors page) — only verify the
    // caller's identity when one is actually present, so the vast majority of
    // /api/quotes polls (no personal key) never pay the extra Supabase round
    // trip. See quotes.js's registerPersonalKey for what this does.
    const personalKey = params.get('finnhubKey');
    if (personalKey && list && list.length) {
      const uid = await verifyUser(req);
      if (uid) quotes.registerPersonalKey(uid, personalKey, list);
    } else if (params.has('finnhubKey') && !personalKey) {
      // Empty finnhubKey= means the user just cleared their saved key.
      const uid = await verifyUser(req);
      if (uid) quotes.removePersonalKey(uid);
    }
    if (list && list.length) {
      // Explicitly requested symbols are portfolio holdings — promote them to
      // the Finnhub hot set so they refresh constantly.
      quotes.ensureWatched(list);
      // A symbol outside the pre-built index universe (e.g. a Sharesies
      // import like ANZ.NZ on the NZX) never appears in the background Yahoo
      // sweep, and Finnhub's free tier doesn't cover non-US listings either
      // — with neither pricing path ever reaching it, it stayed stuck at its
      // initial $0 forever. Mirror /api/ticker and /api/peek: fetch anything
      // still missing from Yahoo right now so it prices immediately instead
      // of waiting on a sweep that will never include it.
      const missing = list.filter((s) => !quotes.one(s));
      if (missing.length) await Promise.all(missing.map((s) => yahoo.fetchNow(s).catch(() => {})));
    }
    return send(res, 200, { enabled: quotes.enabled(), count: quotes.count(), key: quotes.key(), hot: quotes.hotList(), personalKeys: quotes.personalKeyCount(), yahoo: yahoo.status(), yahooFinancials: yahooFinancials.status(), financialsSweep: financialsSweep.status(), quotes: quotes.snapshot(list) });
  }
  // GET /api/history/AAPL  -> recorded price points [[ts,price],...] for charts.
  // First time a symbol is asked for, backfill its daily history from Yahoo
  // (one call); after that the live loop keeps appending new points.
  if (url.startsWith('/api/history/') && req.method === 'GET') {
    const symbol = decodeURIComponent(url.slice('/api/history/'.length).split('?')[0]).toUpperCase();
    if (!history.isBackfilled(symbol)) {
      try {
        history.backfill(symbol, await yahoo.fetchHistory(symbol));
      } catch (e) {
        console.warn('[history] backfill fetch failed for', symbol, e.message);
      }
    }
    // Already seeded, but the app/server wasn't running for a while? Pull just
    // the missing days (see history.ensureFresh) so charts don't depend on
    // having been opened daily.
    await history.ensureFresh(symbol, (range) => yahoo.fetchHistory(symbol, range, '1d'));
    return send(res, 200, { symbol, points: history.read(symbol), backfilled: history.isBackfilled(symbol) });
  }
  // GET /api/intraday/AAPL -> today's real 1-minute bars straight from Yahoo,
  // for the "1D" chart range. Deliberately NOT our own recorded history —
  // that only has a point whenever the sweep/hot-set happened to touch the
  // symbol (dense for actively-watched stocks, sparse for anything else).
  // This is a fresh on-demand pull every time, same as backfill but for
  // today only — not merged into history.js's permanent record, since
  // intraday minute bars for past days aren't something worth keeping
  // forever the way daily closes are.
  if (url.startsWith('/api/intraday/') && req.method === 'GET') {
    const symbol = decodeURIComponent(url.slice('/api/intraday/'.length).split('?')[0]).toUpperCase();
    try {
      const points = await yahoo.fetchHistory(symbol, '1d', '1m');
      return send(res, 200, { symbol, points, timezone: points.timezone || null });
    } catch (e) {
      return send(res, 502, { symbol, error: String(e.message || e) });
    }
  }
  // GET /api/stock/AAPL  -> quote + profile + basic financials for the stock
  // page. Fetches the quote on demand if it isn't cached (symbols outside the
  // priced rotation), so any of the ~24,700 gets live numbers on click.
  if (url.startsWith('/api/stock/') && req.method === 'GET') {
    const symbol = decodeURIComponent(url.slice('/api/stock/'.length).split('?')[0]).toUpperCase();
    let [quote, profile, metrics] = await Promise.all([
      quotes.one(symbol) ? Promise.resolve(quotes.one(symbol)) : quotes.fetchNow(symbol),
      quotes.getProfile(symbol),
      quotes.getMetrics(symbol),
    ]);
    if (!quote) quote = await yahoo.fetchNow(symbol); // Finnhub miss: Yahoo on demand
    return send(res, 200, { symbol, quote, profile, metrics });
  }
  // GET /api/financials/AAPL -> income statement, balance sheet, cash flow
  // (annual + quarterly) for the stock page's Financials tab. Own connector
  // (see server/yahoo-financials.js) — cached for a day server-side, so
  // this is cheap to call on every tab open.
  if (url.startsWith('/api/financials/') && req.method === 'GET') {
    const symbol = decodeURIComponent(url.slice('/api/financials/'.length).split('?')[0]).toUpperCase();
    try {
      const financials = await yahooFinancials.getFinancials(symbol);
      return send(res, 200, { symbol, financials });
    } catch (e) {
      return send(res, 502, { symbol, error: String(e.message || e) });
    }
  }
  // GET /api/analysis/AAPL -> analyst price targets, recommendations,
  // earnings/revenue estimates, earnings history for the stock page's
  // Analysis tab. Same connector as /api/financials above (see
  // server/yahoo-financials.js) — same crumb/cookie session, own disk cache.
  if (url.startsWith('/api/analysis/') && req.method === 'GET') {
    const symbol = decodeURIComponent(url.slice('/api/analysis/'.length).split('?')[0]).toUpperCase();
    try {
      const analysis = await yahooFinancials.getAnalysis(symbol);
      return send(res, 200, { symbol, analysis });
    } catch (e) {
      return send(res, 502, { symbol, error: String(e.message || e) });
    }
  }
  // GET /api/news/AAPL -> top 8 news stories for the stock page's News tab.
  // Own connector (see server/yahoo-news.js), deliberately un-cached and
  // un-merged unlike Financials/Analysis above — a fresh pull from Yahoo
  // every time this tab is opened, one set of stories replacing the last.
  if (url.startsWith('/api/news/') && req.method === 'GET') {
    const symbol = decodeURIComponent(url.slice('/api/news/'.length).split('?')[0]).toUpperCase();
    try {
      const news = await yahooNews.getNews(symbol);
      return send(res, 200, { symbol, news });
    } catch (e) {
      return send(res, 502, { symbol, error: String(e.message || e) });
    }
  }
  // GET /api/pressreleases/AAPL -> top 4 press releases for the stock page's
  // News > Press releases sub-tab. Same connector/endpoint as /api/news
  // above (see server/yahoo-news.js), just filtered to wire-service
  // publishers — same un-cached, un-merged, 1-in-1-out behaviour as News.
  if (url.startsWith('/api/pressreleases/') && req.method === 'GET') {
    const symbol = decodeURIComponent(url.slice('/api/pressreleases/'.length).split('?')[0]).toUpperCase();
    try {
      const news = await yahooNews.getPressReleases(symbol);
      return send(res, 200, { symbol, news });
    } catch (e) {
      return send(res, 502, { symbol, error: String(e.message || e) });
    }
  }
  // GET /api/secfilings/AAPL -> every SEC filing Yahoo has for the stock
  // page's News > SEC filings sub-tab. Same connector as /api/financials/
  // /api/analysis above (see server/yahoo-financials.js) — persisted and
  // merged, not a fresh 1-in-1-out feed like /api/news.
  if (url.startsWith('/api/secfilings/') && req.method === 'GET') {
    const symbol = decodeURIComponent(url.slice('/api/secfilings/'.length).split('?')[0]).toUpperCase();
    try {
      const secFilings = await yahooFinancials.getSecFilings(symbol);
      return send(res, 200, { symbol, secFilings });
    } catch (e) {
      return send(res, 502, { symbol, error: String(e.message || e) });
    }
  }
  // GET /api/statistics/AAPL -> Valuation Measures, Financial Highlights,
  // Trading Information for the stock page's Statistics tab. Same connector
  // as /api/financials//api/analysis/api/secfilings above (see
  // server/yahoo-financials.js) — cached for a day, refreshed on demand.
  if (url.startsWith('/api/statistics/') && req.method === 'GET') {
    const symbol = decodeURIComponent(url.slice('/api/statistics/'.length).split('?')[0]).toUpperCase();
    try {
      const statistics = await yahooFinancials.getStatistics(symbol);
      return send(res, 200, { symbol, statistics });
    } catch (e) {
      return send(res, 502, { symbol, error: String(e.message || e) });
    }
  }
  // GET /api/earnings-calendar?symbols=AAPL,MSFT,... -> [{symbol, earningsDate}]
  // for the Earnings Calendar page. Reuses getStatistics's normal 24h cache
  // per symbol (same connector as everything else here) rather than a
  // separate fetch path — a symbol the fortnightly sweep or another tab has
  // already warmed just returns instantly from cache; anything genuinely
  // uncached still gets fetched here, same as opening that stock's own
  // Statistics tab would. Errors on individual symbols are swallowed (not
  // every symbol necessarily has data) rather than failing the whole batch.
  if (url.startsWith('/api/earnings-calendar') && req.method === 'GET') {
    const q = new URL(url, 'http://x').searchParams.get('symbols');
    const list = q ? q.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
    const results = await Promise.all(list.map(async (symbol) => {
      try {
        const statistics = await yahooFinancials.getStatistics(symbol);
        return { symbol, earningsDate: statistics?.quoteDetail?.earningsDate ?? null };
      } catch {
        return { symbol, earningsDate: null };
      }
    }));
    return send(res, 200, { earnings: results.filter((r) => r.earningsDate != null) });
  }
  // GET /api/valuation/AAPL -> historical Valuation measures (Current + past
  // quarters) for the Statistics tab. Same connector as /api/financials/
  // /api/analysis/etc above (see server/yahoo-financials.js) — the quarterly
  // history is persisted/merged like Financials; "current" is always just
  // the latest live snapshot.
  if (url.startsWith('/api/valuation/') && req.method === 'GET') {
    const symbol = decodeURIComponent(url.slice('/api/valuation/'.length).split('?')[0]).toUpperCase();
    try {
      const valuation = await yahooFinancials.getValuationHistory(symbol);
      return send(res, 200, { symbol, valuation });
    } catch (e) {
      return send(res, 502, { symbol, error: String(e.message || e) });
    }
  }
  // POST /api/coverage-order { order: ['Dow 30', 'S&P 500', ...] } — sets
  // which index group the Yahoo sweep (server/yahoo.js) prioritises, driven
  // by dragging rows on the Connectors page's Live coverage table. A single
  // shared setting (not per-user — there's one sweep), persisted to disk so
  // it survives a restart. Finnhub's hot set is unrelated to this.
  if (url === '/api/coverage-order' && req.method === 'POST') {
    let order = [];
    try { order = (await readBody(req)).order; } catch {}
    yahoo.setPriorityOrder(Array.isArray(order) ? order : []);
    return send(res, 200, { ok: true });
  }
  // Sharesies routes are all scoped to the calling app user — see the
  // "Sessions are keyed by app-user id" note at the top of sharesies.js for
  // why this matters (this server can be hit by multiple signed-in accounts,
  // each with their own separate Sharesies connection). The uid comes from
  // verifyUser(), which asks Supabase itself whose token this is — never
  // trusted directly from a client-supplied header — so one account can't
  // pull another's Sharesies data by simply claiming their id.
  const uid = url.startsWith('/api/sharesies/') ? await verifyUser(req) : null;
  if (url.startsWith('/api/sharesies/') && !uid) {
    return send(res, 401, { error: 'Sign in required' });
  }
  // GET /api/sharesies/status -> { connected, pending } (pending = awaiting 2FA code)
  if (url === '/api/sharesies/status' && req.method === 'GET') {
    return send(res, 200, sharesies.status(uid));
  }
  // POST /api/sharesies/login  { email, password } -> { status: 'connected' | 'mfa_required' }
  if (url === '/api/sharesies/login' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      return send(res, 200, await sharesies.login(uid, body.email, body.password));
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }
  // POST /api/sharesies/2fa  { code } -> { status: 'connected' }
  if (url === '/api/sharesies/2fa' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      return send(res, 200, await sharesies.completeTwoFactor(uid, body.code));
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }
  // POST /api/sharesies/logout -> clears this user's in-memory session
  if (url === '/api/sharesies/logout' && req.method === 'POST') {
    sharesies.logout(uid);
    return send(res, 200, { status: 'disconnected' });
  }
  // GET /api/sharesies/products -> [{ id, name, product, balance }] — every
  // Invest/KiwiSaver/Save/Wallet product under the account, for the Import
  // dialog's "which Sharesies account?" picker.
  if (url === '/api/sharesies/products' && req.method === 'GET') {
    try {
      return send(res, 200, { products: await sharesies.getProducts(uid) });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }
  // GET /api/sharesies/holdings?portfolioId=...  -> [{ ticker, shares, cost }]
  if (url.startsWith('/api/sharesies/holdings') && req.method === 'GET') {
    const portfolioId = new URL(url, 'http://x').searchParams.get('portfolioId');
    try {
      return send(res, 200, { holdings: await sharesies.getHoldings(uid, portfolioId) });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }
  // GET /api/sharesies/history?portfolioId=...  -> [{ date, value, costBasis }]
  if (url.startsWith('/api/sharesies/history') && req.method === 'GET') {
    const portfolioId = new URL(url, 'http://x').searchParams.get('portfolioId');
    try {
      return send(res, 200, { history: await sharesies.getPortfolioHistory(uid, portfolioId) });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
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
  quotes.start(); // Finnhub: hot set only (holdings, ticker strip, favourites)
  yahoo.start({ set: quotes.setExternal }); // everything, including the hot set — see setExternal
  financialsSweep.start(); // fortnightly background refresh of Financials/Analysis for every symbol, not just opened ones

  // Keep-warm loop: FX pairs and index/commodity symbols are few and move
  // slowly, but users expect them always priced (search list, home page). The
  // background sweep only reaches each every ~33 min, so refresh them here on a
  // tight rotation — one every 2s, so ~30 symbols cycle every ~60s.
  const WARM = [
    ...universe.all().filter((x) => /=X$/.test(x.s)).map((x) => x.s), // all FX pairs
    '^GSPC', '^NDX', '^DJI', '^RUT', '^FTSE', '^GDAXI', '^N225', 'DX-Y.NYB', 'GC=F',
  ];
  let wi = 0;
  setInterval(() => {
    if (WARM.length) yahoo.fetchNow(WARM[wi++ % WARM.length]).catch(() => {});
  }, 2000);

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
