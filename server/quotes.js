// quotes.js — live S&P 500 quotes via Finnhub, cached server-side.
//
// Finnhub's free tier allows ~60 calls/min and one symbol per /quote call,
// so we can't fetch all 500 at once. Instead a background loop cycles through
// the symbols a few per second, updating an in-memory cache. The browser polls
// /api/quotes and always gets the latest cached snapshot — no rate-limit or
// CORS problems on the client.
//
// Set FINNHUB_KEY in server/.env to turn this on. Without a key it stays idle
// and /api/quotes returns an empty snapshot (the UI shows "—").

const fs = require('fs');
const path = require('path');

const KEY = process.env.FINNHUB_KEY || '';
const SYMBOLS = JSON.parse(fs.readFileSync(path.join(__dirname, 'sp500-symbols.json'), 'utf8'));

// symbol -> { price, day, prevClose, high, low, ts }
const cache = new Map();
const profiles = new Map(); // symbol -> { marketCap, name, ... } (fetched lazily)

let cursor = 0;
let started = false;
let paused = false; // held while the universe list refreshes, so its one call gets through

async function fetchQuote(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`finnhub ${r.status}`);
  const q = await r.json();
  // Finnhub /quote: c=current, d=change, dp=%change, h=high, l=low, pc=prevClose
  if (q && typeof q.c === 'number' && q.c > 0) {
    cache.set(symbol, { price: q.c, day: q.dp ?? 0, prevClose: q.pc ?? 0, high: q.h ?? 0, low: q.l ?? 0, ts: Date.now() });
  }
}

// ~8 symbols every 1.2s ≈ 400/min worst case; we throttle to stay well under
// the limit by spacing single calls. Full cycle of 500 ≈ 8 min.
function start() {
  if (started || !KEY) return;
  started = true;
  console.log('[quotes] Finnhub key found — starting background fetch of', SYMBOLS.length, 'symbols');
  const tick = async () => {
    if (paused) {
      setTimeout(tick, 500);
      return;
    }
    const symbol = SYMBOLS[cursor % SYMBOLS.length];
    cursor++;
    try {
      await fetchQuote(symbol);
    } catch (e) {
      // transient (rate limit / network); back off briefly
      await new Promise((r) => setTimeout(r, 800));
    }
    setTimeout(tick, 120); // ~8/sec budget, but most ticks include the fetch latency
  };
  tick();
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
  start,
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
  one: (s) => cache.get(s) || null,
};
