// yahoo.js — bulk quotes via Yahoo Finance's public chart endpoint.
//
// Role: the default price source for the whole ~24,700-symbol universe,
// including the Finnhub hot set (portfolio holdings, ticker-strip symbols,
// favourites) — Finnhub is the *override*, not a replacement: quotes.js's
// setExternal() only lets this sweep's price through if there's no fresh
// (<2min) Finnhub-sourced quote already cached for that symbol. This means
// a hot symbol Finnhub can't price (e.g. a non-US listing outside its free
// tier) still gets kept alive by Yahoo instead of freezing at $0. Symbols
// with index tags (S&P 500 etc.) sit at the front of each sweep so the
// visible boards stay freshest.
//
// The v8/finance/chart endpoint needs no API key or crumb, just a browser-ish
// User-Agent. It's unofficial: expect the occasional 429/999, so the loop
// backs off on errors and reports status for the Connectors page.

const universe = require('./universe');
const history = require('./history');

// Yahoo's WAF 429s full browser UA strings from non-browser TLS stacks, but
// passes this bare one. Tested 2026-07: full Chrome UA -> 429, this -> 200.
const UA = 'Mozilla/5.0 (X11; Linux x86_64)';
const SPACING_MS = 400; // ~2.5 req/sec — gentle enough to avoid IP bans
const ERROR_BACKOFF_MS = 15000;

let setQuote = null; // (symbol, data) -> void, provided by quotes.js
let started = false;
let cursor = 0;
let list = [];
let lapStartTs = 0; // when the current sweep lap began — lets the Connectors page show "updated this lap" per index group
let ok = 0;
let fail = 0;
let lastTs = 0;
let lastErr = '';
let consecutiveFails = 0; // see the backoff comment in tick() below

// Marks an error as "worth backing off for" (real throttling — 429/999, or a
// network-level failure with no status at all) vs. a permanently-bad symbol
// (404: delisted, wrong suffix mapping, no price) that will fail the exact
// same way no matter how long the sweep waits before retrying it.
function throttleError(message, isThrottle) {
  return Object.assign(new Error(message), { isThrottle });
}
async function fetchOne(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw throttleError('yahoo ' + r.status, r.status === 429 || r.status === 999);
  const meta = (await r.json())?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') throw throttleError('yahoo: no price', false);
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? 0;
  return {
    price: meta.regularMarketPrice,
    day: prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0,
    prevClose: prev,
    high: meta.regularMarketDayHigh ?? 0,
    low: meta.regularMarketDayLow ?? 0,
    open: meta.regularMarketOpen ?? 0,
    ts: Date.now(),
    source: 'yahoo',
  };
}

// Sweep order: index-tagged symbols first (the visible boards), then the rest
// of the universe, capped at SWEEP_CAP. ~5,000 at 2.5/sec ≈ a 33-minute sweep,
// well inside what Yahoo tolerates from one IP. Anything beyond the cap still
// gets priced on demand (fetchNow) when its stock page is opened. Rebuilt at
// the top of each sweep to pick up universe refreshes.
//
// Group priority within the tagged bucket comes from the Connectors page's
// "Live coverage" table — whatever order the user drags those rows into
// (see saveCoverageOrder in app.js and the /api/coverage-order route in
// server.js) is the order those index groups get swept in, so dragging a
// group to the top means it refreshes soonest each lap. Persisted here
// (not just the client's localStorage) so it survives a server restart.
// Finnhub's hot set is untouched by this — it has its own separate priority
// (quotes.js's watch set) and doesn't go through this list at all.
const fs = require('fs');
const path = require('path');
const ORDER_FILE = path.join(__dirname, '..', 'data', 'coverage-order.json');
let priorityOrder = [];
try { priorityOrder = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8')); } catch {}
function setPriorityOrder(order) {
  priorityOrder = Array.isArray(order) ? order : [];
  try { fs.writeFileSync(ORDER_FILE, JSON.stringify(priorityOrder)); } catch {}
}

const SWEEP_CAP = Number(process.env.YAHOO_SWEEP_CAP || 5000);
function buildList() {
  const all = universe.all();
  const byTag = new Map(); // tag -> symbols with that tag, in universe order
  const untagged = [];
  for (const x of all) {
    if (x.tags && x.tags.length) {
      for (const t of x.tags) {
        if (!byTag.has(t)) byTag.set(t, []);
        byTag.get(t).push(x.s);
      }
    } else {
      untagged.push(x.s);
    }
  }
  // 'Unindexed' in the saved order stands in for the untagged bucket (same
  // name the Connectors page's coverage table uses for it).
  const tagOrder = priorityOrder.length ? priorityOrder : [...byTag.keys()];
  const seen = new Set();
  const out = [];
  const addAll = (syms) => { for (const s of syms) if (!seen.has(s)) { seen.add(s); out.push(s); } };
  for (const t of tagOrder) (t === 'Unindexed' ? addAll(untagged) : addAll(byTag.get(t) || []));
  for (const [t, syms] of byTag) if (!tagOrder.includes(t)) addAll(syms); // any tag not yet ordered (e.g. new one)
  addAll(untagged); // untagged, if 'Unindexed' wasn't in the saved order either
  list = out.slice(0, SWEEP_CAP);
}

function start(hooks) {
  if (started) return;
  setQuote = hooks.set;
  started = true;
  buildList();
  lapStartTs = Date.now();
  console.log('[yahoo] starting bulk quote sweep of', list.length, 'symbols (covers the hot set too — see setExternal)');
  const tick = async () => {
    if (!list.length || cursor >= list.length) {
      cursor = 0;
      buildList();
      lapStartTs = Date.now();
    }
    const symbol = list[cursor++];
    if (!symbol) {
      setImmediate(tick); // skip instantly, no budget spent
      return;
    }
    try {
      const q = await fetchOne(symbol);
      setQuote(symbol, q);
      history.record(symbol, q.price);
      ok++;
      lastTs = q.ts;
      consecutiveFails = 0;
      setTimeout(tick, SPACING_MS);
    } catch (e) {
      fail++;
      lastErr = String(e.message || e);
      // A 404 (delisted ticker, wrong suffix mapping) will fail exactly the
      // same way no matter how long the sweep waits before retrying it —
      // backing off only helps for a REAL throttle signal (429/999, or a
      // network-level error with no HTTP status at all). The "Unindexed"
      // bucket (~22k symbols, lots of junk/delisted tickers) can have long
      // runs of consecutive 404s; treating those like rate-limiting used to
      // stretch a ~33-minute sweep to well over a day. Only count a symbol
      // toward the backoff streak when it's actually throttle-shaped.
      const isThrottle = e.isThrottle !== false; // no status at all (network error) defaults to true
      if (isThrottle) consecutiveFails++; else consecutiveFails = 0;
      const delay = isThrottle && consecutiveFails >= 3 ? ERROR_BACKOFF_MS : SPACING_MS;
      setTimeout(tick, delay);
    }
  };
  tick();
}

// Historical daily closes for the chart backfill — one call returns the whole
// range, and only ever runs once per symbol (history.js's .bf marker) — the
// live sweep just appends new points after that, so a longer range here only
// costs one bigger one-off response, not anything ongoing. Yahoo supports
// back to a stock's actual listing (tested: AAPL goes to 1984 with range=max);
// 20y is a deliberately generous default rather than 'max' so a very old
// stock's backfill doesn't return an excessive number of daily points.
async function fetchHistory(symbol, range = '20y', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('yahoo hist ' + r.status);
  const res = (await r.json())?.chart?.result?.[0];
  const ts = res?.timestamp || [];
  const close = res?.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    // Yahoo occasionally returns a spurious near-zero close (e.g. around a
    // trading halt) — a real security price is never <= 0, so drop those
    // rather than let a consumer plot a vertical spike down to the axis.
    if (typeof close[i] === 'number' && close[i] > 0) out.push([ts[i] * 1000, close[i]]);
  }
  // Stashed as a non-enumerable-ish extra property rather than changing the
  // return shape to {points, timezone} — history.backfill() and every other
  // existing caller just wants the plain array of [ts, close] tuples.
  out.timezone = res?.meta?.exchangeTimezoneName || null;
  return out;
}

// On-demand fetch for the stock page (symbol may be deep in the sweep queue).
async function fetchNow(symbol) {
  try {
    const q = await fetchOne(symbol);
    if (setQuote) setQuote(symbol, q);
    history.record(symbol, q.price);
    ok++;
    lastTs = q.ts;
    return q;
  } catch (e) {
    fail++;
    lastErr = String(e.message || e);
    return null;
  }
}

module.exports = {
  start,
  fetchNow,
  fetchHistory,
  setPriorityOrder,
  status: () => ({ enabled: started, ok, fail, lastTs, lastErr, universe: list.length, lapStartTs }),
};
