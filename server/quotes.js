// quotes.js — live index quotes via Finnhub, cached server-side.
//
// Finnhub's free tier allows ~60 calls/min and one symbol per /quote call, so
// we can't fetch everything at once. We price a prioritised set — the Dow 30,
// Nasdaq-100, and S&P 500 — and a background loop cycles through it a few per
// second, updating an in-memory cache. The browser polls /api/quotes and always
// gets the latest cached snapshot — no rate-limit or CORS problems on the client.
//
// The cycle order is the priority: Dow first, then Nasdaq-100, then the rest of
// the S&P 500, so the highest-profile names are freshest. (Later this becomes
// user-tunable via in-app sliders; for now it's a fixed order.)
//
// Set FINNHUB_KEY in server/.env to turn this on. Without a key it stays idle
// and /api/quotes returns an empty snapshot (the UI shows "—").

const fs = require('fs');
const path = require('path');
const history = require('./history');

const KEY = process.env.FINNHUB_KEY || '';
const DATA = path.join(__dirname, '..', 'data');

// Build the prioritised symbol list from the cached index memberships
// (data/index-*.json, maintained by indexes.js). Order = refresh priority:
// Dow 30 → Nasdaq-100 → S&P 500, deduped. Falls back to the static S&P list if
// the index caches aren't present yet (e.g. a fresh checkout before first run).
function loadSymbols() {
  const readIndex = (file) => {
    try {
      return Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')));
    } catch {
      return [];
    }
  };
  const ordered = [
    ...readIndex('index-dow.json'),
    ...readIndex('index-ndx.json'),
    ...readIndex('index-sp500.json'),
  ];
  const deduped = [...new Set(ordered)];
  if (deduped.length) return deduped;
  // Fallback: the static list that shipped with the repo.
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'sp500-symbols.json'), 'utf8'));
  } catch {
    return [];
  }
}

const SYMBOLS = loadSymbols();

// symbol -> { price, day, prevClose, high, low, ts, source }
const cache = new Map();
const profiles = new Map(); // symbol -> { marketCap, name, ... } (fetched lazily)

// The cache is in-memory, so a restart would otherwise start cold and take a
// full ~33-min Yahoo sweep to re-warm. Persist it to disk periodically and
// reload on boot so restarts come back with all previously-priced symbols;
// the sweep then just tops them up. Prices carry their own `ts`, so the UI can
// tell how fresh each one is.
const CACHE_FILE = path.join(DATA, 'quotes-cache.json');
function loadCache() {
  try {
    const obj = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(obj)) cache.set(k, v);
    if (cache.size) console.log('[quotes] restored', cache.size, 'cached quotes from disk');
  } catch {}
}
function saveCache() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const obj = {};
    for (const [k, v] of cache) obj[k] = v;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch (e) {
    console.warn('[quotes] cache save failed:', e.message);
  }
}
loadCache();
setInterval(saveCache, 60 * 1000).unref();
process.on('exit', saveCache);
process.on('SIGINT', () => { saveCache(); process.exit(0); });
process.on('SIGTERM', () => { saveCache(); process.exit(0); });

let cursor = 0; // total ticks (drives the watch/main interleave)
let mainCursor = 0; // position in the big board rotation
let wCursor = 0; // position in the watch (ticker) rotation
let started = false;
let paused = false; // held while the universe list refreshes, so its one call gets through

async function fetchQuote(symbol, key = KEY) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`finnhub ${r.status}`);
  const q = await r.json();
  // Finnhub /quote: c=current, d=change, dp=%change, h=high, l=low, pc=prevClose
  if (q && typeof q.c === 'number' && q.c > 0) {
    cache.set(symbol, { price: q.c, day: q.dp ?? 0, prevClose: q.pc ?? 0, high: q.h ?? 0, low: q.l ?? 0, open: q.o ?? 0, ts: Date.now(), source: key === KEY ? 'finnhub' : 'finnhub-personal' });
    history.record(symbol, q.c); // permanent price history (feeds the charts)
  }
}

// A user's own free Finnhub key (pasted on the Connectors page — see
// store.js's getFinnhubKey/saveFinnhubKey) gets its own dedicated loop and
// its own independent 60-calls/min budget, cycling only *that* user's
// holdings, instead of those symbols sharing the one server-wide key's
// budget with the hot set below and every other user. Purely additive/opt-in
// — a user with no personal key keeps using the shared hot set exactly as
// before. Not persisted server-side: the key lives in Supabase (the client's
// own data), and is re-registered here the moment the client's next poll
// includes it (see the /api/quotes handler in server.js), so a server
// restart just picks the loop back up on the client's next request.
const userLoops = new Map(); // uid -> { key, symbols: Set, cursor, running }

function registerPersonalKey(uid, key, symbols) {
  if (!uid || !key) return;
  let loop = userLoops.get(uid);
  if (!loop) {
    loop = { key, symbols: new Set(), cursor: 0, running: false };
    userLoops.set(uid, loop);
  }
  loop.key = key; // may have changed if the user pasted a new one
  for (const s of symbols) loop.symbols.add(s);
  if (!loop.running) startUserLoop(uid);
}

function removePersonalKey(uid) {
  userLoops.delete(uid); // tick() below checks for this and stops itself
}

function startUserLoop(uid) {
  const loop = userLoops.get(uid);
  if (!loop || loop.running) return;
  loop.running = true;
  const tick = async () => {
    const cur = userLoops.get(uid);
    if (!cur) return; // key removed — stop this loop for good
    const list = [...cur.symbols];
    if (!list.length) { setTimeout(tick, 5000); return; }
    const symbol = list[cur.cursor % list.length];
    cur.cursor++;
    try {
      await fetchQuote(symbol, cur.key);
      setTimeout(tick, 1000); // 60/min — this user's own budget, not the shared one
    } catch {
      setTimeout(tick, 2000); // bad/rate-limited personal key — brief back-off, keep trying
    }
  };
  tick();
}

// Extra symbols the market-ticker strip wants priced (index ETFs by default,
// plus anything the user adds). These are folded into the front of the refresh
// rotation so the visible strip stays the freshest. Registering a new one also
// fetches it immediately so it appears without waiting for a cycle.
const INDEX_ETFS = ['SPY', 'QQQ', 'DIA', 'GLD', 'IWM'];
const watch = new Set(INDEX_ETFS);
function ensureWatched(symbols) {
  for (const s of symbols) {
    if (!s) continue;
    const wasNew = !watch.has(s);
    watch.add(s);
    if (KEY && wasNew && !cache.has(s)) fetchQuote(s).catch(() => {});
  }
}

// Finnhub is the premium lane: its stable 60/min budget goes entirely to the
// hot set (`watch`) — portfolio holdings, ticker-strip symbols, favourites.
// Everything else in the universe is priced by the Yahoo sweep (yahoo.js),
// which writes into this same cache via setExternal(). With a hot set of ~20
// symbols, each refreshes every ~20s all day.
function start() {
  if (started || !KEY) return;
  started = true;
  console.log('[quotes] Finnhub key found — pricing the hot set (', watch.size, 'symbols to start )');
  const tick = async () => {
    if (paused) {
      setTimeout(tick, 500);
      return;
    }
    const w = [...watch];
    const symbol = w[wCursor % w.length];
    wCursor++;
    try {
      await fetchQuote(symbol);
    } catch (e) {
      // transient (rate limit / network); back off briefly
      await new Promise((r) => setTimeout(r, 800));
    }
    setTimeout(tick, 1000); // 60/min — exactly the free-tier budget
  };
  tick();
}

// Entry point for the Yahoo sweep: fills the cache for everything outside the
// hot set. Hot symbols with a fresh Finnhub quote are left alone — but if
// Finnhub can't price one (e.g. a non-US listing like RR.L), Yahoo may still
// keep it alive rather than letting it freeze.
function setExternal(symbol, data) {
  if (watch.has(symbol)) {
    const cur = cache.get(symbol);
    if (cur && cur.source === 'finnhub' && Date.now() - cur.ts < 120000) return;
  }
  cache.set(symbol, data);
}

// Fetch a symbol's quote right now (for the stock page — the symbol may not be
// in any rotation yet). Returns the cached entry, fresh or last-known.
async function fetchNow(symbol) {
  if (KEY && !paused) {
    try {
      await fetchQuote(symbol);
    } catch {}
  }
  return cache.get(symbol) || null;
}

// Basic financials (Finnhub /stock/metric, free tier): beta, PE, EPS,
// 52-week range, average volume. Cached; missing fields stay undefined and the
// UI shows them unpopulated.
const metricsCache = new Map();
async function getMetrics(symbol) {
  if (metricsCache.has(symbol)) return metricsCache.get(symbol);
  if (!KEY) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${KEY}`);
    if (r.ok) {
      const m = (await r.json()).metric || {};
      const out = {
        beta: m.beta,
        pe: m.peTTM,
        eps: m.epsTTM,
        high52: m['52WeekHigh'],
        low52: m['52WeekLow'],
        avgVol10d: m['10DayAverageTradingVolume'], // millions of shares
        divYield: m.dividendYieldIndicatedAnnual,
      };
      metricsCache.set(symbol, out);
      return out;
    }
  } catch {}
  return null;
}

async function getProfile(symbol) {
  if (profiles.has(symbol)) return profiles.get(symbol);
  if (!KEY) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${KEY}`);
    if (r.ok) {
      const p = await r.json();
      const prof = { marketCap: p.marketCapitalization || 0, name: p.name || '', logo: p.logo || '', industry: p.finnhubIndustry || '', exchange: p.exchange || '' };
      profiles.set(symbol, prof);
      return prof;
    }
  } catch {}
  return null;
}

module.exports = {
  enabled: () => !!KEY,
  key: () => KEY,
  start,
  ensureWatched,
  setExternal,
  isWatched: (s) => watch.has(s),
  hotList: () => [...watch],
  pause: () => { paused = true; },
  resume: () => { paused = false; },
  // snapshot of requested symbols (or all if none given)
  snapshot(symbols) {
    const out = {};
    const list = symbols && symbols.length ? symbols : [...cache.keys()];
    for (const s of list) {
      const v = cache.get(s);
      if (v) out[s] = v;
    }
    return out;
  },
  count: () => cache.size,
  getProfile,
  getMetrics,
  fetchNow,
  one: (s) => cache.get(s) || null,
  registerPersonalKey,
  removePersonalKey,
  personalKeyCount: () => userLoops.size,
};
