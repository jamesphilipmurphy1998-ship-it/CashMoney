// history.js — permanent price-history recording.
//
// Every successful quote fetch is recorded here (stocks, index ETFs, anything
// the quote loop or a stock page touches). Points are throttled to one per
// symbol per minute and appended to data/history/<SYM>.jsonl — one
// `[timestamp_ms, price]` per line, append-only, so history survives restarts
// and grows forever. This feeds the stock-page charts.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'history');
const MIN_GAP_MS = 60 * 1000; // at most one point per symbol per minute
const FLUSH_MS = 60 * 1000; // write buffered points to disk once a minute

const lastTs = new Map(); // symbol -> ts of last recorded point
const buffer = new Map(); // symbol -> array of "[ts,price]" lines not yet on disk

// Safe filename: tickers can contain '.', '-' etc.; block path separators.
const fileFor = (sym) => path.join(DIR, sym.replace(/[^A-Za-z0-9._\-^=]/g, '_') + '.jsonl');

function record(symbol, price, ts = Date.now()) {
  const last = lastTs.get(symbol) || 0;
  if (ts - last < MIN_GAP_MS) return;
  lastTs.set(symbol, ts);
  if (!buffer.has(symbol)) buffer.set(symbol, []);
  buffer.get(symbol).push(JSON.stringify([ts, price]));
}

function flush() {
  if (!buffer.size) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {}
  for (const [sym, lines] of buffer) {
    if (!lines.length) continue;
    try {
      fs.appendFileSync(fileFor(sym), lines.join('\n') + '\n');
      buffer.set(sym, []);
    } catch (e) {
      // keep the buffer; retry next flush
      console.warn('[history] flush failed for', sym, e.message);
    }
  }
}

// One-time backfill from an external source (Yahoo daily closes). Merges the
// given [ts, price] points with whatever we've already recorded, dedupes so
// there's at most one point per calendar day for the historical portion, and
// rewrites the file. A ".bf" marker records that we've seeded this symbol so
// we never refetch — from then on the live loop just appends new points.
const bfDone = new Set();
function isBackfilled(symbol) {
  if (bfDone.has(symbol)) return true;
  try { fs.accessSync(fileFor(symbol) + '.bf'); bfDone.add(symbol); return true; } catch { return false; }
}
function backfill(symbol, points) {
  if (isBackfilled(symbol) || !points || !points.length) return;
  flush(); // get any buffered live points onto disk first
  const existing = read(symbol, 100000);
  // Dedupe by calendar day, keeping the last price seen for that day.
  const byDay = new Map();
  for (const [ts, p] of [...points, ...existing]) {
    if (typeof ts !== 'number' || typeof p !== 'number') continue;
    byDay.set(new Date(ts).toISOString().slice(0, 10), [ts, p]);
  }
  const merged = [...byDay.values()].sort((a, b) => a[0] - b[0]);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(fileFor(symbol), merged.map((pt) => JSON.stringify(pt)).join('\n') + '\n');
    fs.writeFileSync(fileFor(symbol) + '.bf', String(Date.now()));
    bfDone.add(symbol);
  } catch (e) {
    console.warn('[history] backfill write failed for', symbol, e.message);
  }
}

// Gap-fill. backfill() above only ever runs once per symbol, after which the
// only thing adding points is the live price loop — which only runs while the
// server is up AND the symbol is being priced. Any day the server was off (or
// the symbol wasn't in the sweep) is simply never recorded, so charts only
// looked complete if the app had been opened daily. ensureFresh() closes that
// lazily, the next time a symbol's history is read: if the newest point is
// more than ~a day old it fetches just the missing days from Yahoo and appends
// them (one point per day, never today, never anything already stored) — no
// re-download of what we already have.
const GAP_STALE_MS = 30 * 60 * 60 * 1000; // newest point older than this => look for missing days
const GAP_RECHECK_MS = 6 * 60 * 60 * 1000; // ...but ask Yahoo at most this often per symbol (weekends/holidays legitimately have no new bars)
const gapCheckedAt = new Map();
const gapInflight = new Map();
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

// Smallest Yahoo range that still covers the gap (plus a few days' slack).
function rangeForGap(lastTs) {
  const days = (Date.now() - lastTs) / 864e5 + 5;
  for (const [limit, range] of [[5, '5d'], [30, '1mo'], [90, '3mo'], [180, '6mo'], [365, '1y'], [730, '2y'], [1825, '5y']]) {
    if (days <= limit) return range;
  }
  return '10y';
}

async function ensureFresh(symbol, fetchDaily) {
  if (!isBackfilled(symbol)) return 0; // first-time seeding is backfill()'s job
  if (gapInflight.has(symbol)) return gapInflight.get(symbol); // collapse concurrent requests
  const now = Date.now();
  if (now - (gapCheckedAt.get(symbol) || 0) < GAP_RECHECK_MS) return 0;
  const recent = read(symbol, 1);
  if (!recent.length) return 0;
  const newestTs = recent[0][0];
  if (now - newestTs < GAP_STALE_MS) return 0;

  const job = (async () => {
    try {
      const fetched = await fetchDaily(rangeForGap(newestTs));
      flush(); // buffered live points first, so the file stays in time order
      const newest = read(symbol, 1)[0][0];
      const lastDay = dayKey(newest);
      const today = dayKey(Date.now());
      const byDay = new Map(); // last bar per missing day
      for (const [ts, p] of fetched || []) {
        if (typeof ts !== 'number' || typeof p !== 'number') continue;
        const d = dayKey(ts);
        if (d > lastDay && d < today) byDay.set(d, [ts, p]);
      }
      const fresh = [...byDay.values()].sort((a, b) => a[0] - b[0]);
      if (!fresh.length) return 0;
      fs.mkdirSync(DIR, { recursive: true });
      fs.appendFileSync(fileFor(symbol), fresh.map((pt) => JSON.stringify(pt)).join('\n') + '\n');
      lastTs.set(symbol, fresh[fresh.length - 1][0]); // keep record()'s 1-per-minute throttle in step
      console.log('[history] gap-filled', symbol, '+' + fresh.length, 'days (' + lastDay + ' -> ' + dayKey(fresh[fresh.length - 1][0]) + ')');
      return fresh.length;
    } catch (e) {
      console.warn('[history] gap-fill failed for', symbol, e.message);
      return 0;
    } finally {
      gapCheckedAt.set(symbol, Date.now());
      gapInflight.delete(symbol);
    }
  })();
  gapInflight.set(symbol, job);
  return job;
}

// Read a symbol's recorded points (disk + unflushed buffer), newest last.
// `limit` caps the number of points returned (most recent kept).
function read(symbol, limit = 5000) {
  let points = [];
  try {
    const raw = fs.readFileSync(fileFor(symbol), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        points.push(JSON.parse(line));
      } catch {}
    }
  } catch {}
  for (const line of buffer.get(symbol) || []) points.push(JSON.parse(line));
  if (points.length > limit) points = points.slice(-limit);
  return points;
}

setInterval(flush, FLUSH_MS).unref();
process.on('exit', flush);
process.on('SIGINT', () => {
  flush();
  process.exit(0);
});
process.on('SIGTERM', () => {
  flush();
  process.exit(0);
});

module.exports = { record, read, flush, backfill, isBackfilled, ensureFresh };
