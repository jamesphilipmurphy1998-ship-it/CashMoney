// universe.js — the searchable stock library, self-refreshing weekly.
//
// Serves the list of stocks the Search box filters over. Each entry carries
// index membership tags (e.g. "S&P 500"), which later drive load priority.
//
//   { s: "AAPL", n: "Apple Inc.", tags: ["S&P 500"], sec: "Information Technology" }
//
// The list is saved to data/universe.json and reused across restarts. On
// startup (and once a day thereafter) it re-pulls from Finnhub only if the
// file is missing or older than a week — so new listings and delistings show
// up on their own, without ever spamming the API.

const fs = require('fs');
const path = require('path');
const indexes = require('./indexes');

const UNIVERSE_FILE = path.join(__dirname, '..', 'data', 'universe.json');
const SP_FALLBACK = path.join(__dirname, 'sp500-symbols.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // one week
const KEY = process.env.FINNHUB_KEY || '';
const KEEP_TYPES = new Set(['Common Stock', 'ETP']);

let symbols = [];

// Live FX pairs (Yahoo =X symbols) added to the searchable universe so users
// can find them by code, pair, or currency name. [pair, readable, full name].
// Names embed "Currency" so a search for "currency" lists them all, and the
// full name so "yen"/"pound"/"euro" match too.
const CURRENCIES = [
  ['EURUSD=X', 'EUR/USD', 'Euro'], ['GBPUSD=X', 'GBP/USD', 'British Pound'],
  ['USDJPY=X', 'USD/JPY', 'Japanese Yen'], ['AUDUSD=X', 'AUD/USD', 'Australian Dollar'],
  ['NZDUSD=X', 'NZD/USD', 'New Zealand Dollar'], ['USDCAD=X', 'USD/CAD', 'Canadian Dollar'],
  ['USDCHF=X', 'USD/CHF', 'Swiss Franc'], ['USDCNY=X', 'USD/CNY', 'Chinese Yuan'],
  ['USDSGD=X', 'USD/SGD', 'Singapore Dollar'], ['USDHKD=X', 'USD/HKD', 'Hong Kong Dollar'],
  ['USDINR=X', 'USD/INR', 'Indian Rupee'], ['USDKRW=X', 'USD/KRW', 'South Korean Won'],
  ['USDMXN=X', 'USD/MXN', 'Mexican Peso'], ['USDZAR=X', 'USD/ZAR', 'South African Rand'],
  ['USDSEK=X', 'USD/SEK', 'Swedish Krona'], ['USDNOK=X', 'USD/NOK', 'Norwegian Krone'],
  ['USDBRL=X', 'USD/BRL', 'Brazilian Real'], ['USDTRY=X', 'USD/TRY', 'Turkish Lira'],
  ['EURGBP=X', 'EUR/GBP', 'Euro / Pound'], ['EURJPY=X', 'EUR/JPY', 'Euro / Yen'],
  ['GBPJPY=X', 'GBP/JPY', 'Pound / Yen'], ['AUDNZD=X', 'AUD/NZD', 'Aussie / Kiwi'],
];
function currencyRows() {
  return CURRENCIES.map(([s, pair, full]) => ({ s, n: `${full} · ${pair} · Currency`, tags: ['Currency'] }));
}

// Major index/commodity levels shown on the ticker strip and kept warm by
// server.js's WARM loop — previously viewable only by clicking them there
// (StockPage.show doesn't require a symbol to be in the universe), but not
// findable by typing "S&P 500" etc. into the search bar. Added here the same
// way the FX pairs above are, so they're properly searchable too.
const MAJOR_INDICES = [
  ['^GSPC', 'S&P 500 Index'], ['^NDX', 'Nasdaq 100 Index'], ['^DJI', 'Dow Jones Industrial Average'],
  ['^RUT', 'Russell 2000 Index'], ['^FTSE', 'FTSE 100 Index'], ['^GDAXI', 'DAX Index'],
  ['^N225', 'Nikkei 225 Index'], ['DX-Y.NYB', 'US Dollar Index'], ['GC=F', 'Gold'],
];
function majorIndexRows() {
  return MAJOR_INDICES.map(([s, n]) => ({ s, n: `${n} · Index`, tags: ['Major Indices'] }));
}

function load() {
  try {
    symbols = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
    return true;
  } catch {}
  try {
    const sp = JSON.parse(fs.readFileSync(SP_FALLBACK, 'utf8'));
    symbols = sp.map((s) => ({ s, n: s, tags: ['S&P 500'] }));
    console.log('[universe] no saved file — using S&P 500 fallback (', symbols.length, ')');
    return false;
  } catch {
    symbols = [];
    return false;
  }
}

// Pull the full US symbol list from Finnhub plus current index memberships,
// and rebuild the tagged file. Node's fetch follows Finnhub's 302 redirect to
// the signed file automatically.
async function rebuild() {
  // Index memberships come from their own sources (not Finnhub) — fetch first,
  // since they succeed even when Finnhub is rate-limited.
  const memberships = await indexes.fetchMemberships();

  // Base symbol list: the full US universe from Finnhub. This rarely changes,
  // so if Finnhub 429s we fall back to re-tagging the symbols we already have
  // on disk — that way new index tags still apply without a Finnhub call.
  let data = null;
  if (KEY) {
    try {
      const symRes = await fetch(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${KEY}`);
      if (!symRes.ok) throw new Error(`finnhub symbols ${symRes.status}`);
      const json = await symRes.json();
      if (!Array.isArray(json)) throw new Error('unexpected symbols response');
      data = json.map((x) => ({ symbol: x.symbol, type: x.type, description: x.description }));
    } catch (e) {
      console.warn('[universe] Finnhub symbol list unavailable (', e.message, ') — re-tagging existing list');
    }
  }
  if (!data) {
    if (!symbols.length) load();
    if (!symbols.length) return false; // nothing to work with
    // Reuse cached symbols as the base; treat all as keepable (they were kept
    // before), tags get recomputed fresh below.
    data = symbols.map((x) => ({ symbol: x.s, type: 'Common Stock', description: x.n }));
  }

  // Build symbol -> tags and symbol -> { n, sec } from every index source.
  const memberOf = {};
  const metaBy = {};
  for (const idx of memberships) {
    for (const [sym, meta] of Object.entries(idx.members)) {
      (memberOf[sym] || (memberOf[sym] = [])).push(idx.tag);
      const mb = metaBy[sym] || (metaBy[sym] = {});
      if (meta.n && !mb.n) mb.n = meta.n;
      if (meta.sec && !mb.sec) mb.sec = meta.sec;
    }
  }

  const rows = [];
  const seen = new Set();
  // Synthetic rows (FX pairs, major indices) go first and claim `seen` before
  // the Finnhub-derived loop below — otherwise, on the fallback path (Finnhub
  // symbol list unavailable, so existing symbols get re-tagged as if they
  // were fresh Finnhub data), these symbols would get reprocessed there with
  // tags recomputed purely from memberOf (which knows nothing about currency
  // pairs or index levels), wiping their synthetic tag, and — since they'd
  // already be marked seen — never get a chance to be re-added correctly
  // by this block if it ran after. Order matters here.
  for (const row of currencyRows()) {
    if (seen.has(row.s)) continue;
    seen.add(row.s);
    rows.push(row);
  }
  for (const row of majorIndexRows()) {
    if (seen.has(row.s)) continue;
    seen.add(row.s);
    rows.push(row);
  }
  for (const x of data) {
    const sym = (x.symbol || '').trim();
    const type = x.type || '';
    if (!sym || seen.has(sym)) continue;
    const tags = memberOf[sym] || [];
    if (!KEEP_TYPES.has(type) && !tags.length) continue; // always keep index members
    seen.add(sym);
    const meta = metaBy[sym] || {};
    const row = { s: sym, n: meta.n || x.description || sym, tags };
    if (meta.sec) row.sec = meta.sec;
    rows.push(row);
  }
  // Index members outside the Finnhub US list (FTSE/DAX/Nikkei symbols carry
  // Yahoo exchange suffixes like .L/.DE/.T) get their own rows — Yahoo prices
  // them, Finnhub just never sees them.
  for (const [sym, tags] of Object.entries(memberOf)) {
    if (seen.has(sym)) continue;
    seen.add(sym);
    const meta = metaBy[sym] || {};
    const row = { s: sym, n: meta.n || sym, tags };
    if (meta.sec) row.sec = meta.sec;
    rows.push(row);
  }
  rows.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));

  fs.mkdirSync(path.dirname(UNIVERSE_FILE), { recursive: true });
  fs.writeFileSync(UNIVERSE_FILE, JSON.stringify(rows));
  symbols = rows;
  return true;
}

function ageMs() {
  try {
    return Date.now() - fs.statSync(UNIVERSE_FILE).mtimeMs;
  } catch {
    return Infinity; // missing = infinitely old
  }
}

// Every index the app expects tags for; a saved universe missing any of these
// was built before that source existed, so rebuild even if the file is fresh.
const WANT_TAGS = ['S&P 500', 'Nasdaq 100', 'Dow 30', 'Russell 2000', 'FTSE 100', 'DAX', 'Nikkei 225', 'Currency', 'Major Indices'];
function hasAllTags() {
  const have = new Set();
  for (const x of symbols) for (const t of x.tags || []) have.add(t);
  return WANT_TAGS.every((t) => have.has(t));
}

// Refresh if the saved list is missing or older than a week; otherwise reuse.
async function ensureFresh() {
  if (ageMs() < MAX_AGE_MS) {
    load();
    if (hasAllTags()) {
      console.log('[universe] loaded', symbols.length, 'symbols (file is fresh)');
      return;
    }
    console.log('[universe] fresh file but missing new index tags — rebuilding…');
  }
  console.log('[universe] list missing or >7 days old — refreshing from Finnhub…');
  try {
    if (await rebuild()) {
      console.log('[universe] refreshed:', symbols.length, 'symbols saved');
    } else {
      load();
    }
  } catch (e) {
    console.warn('[universe] refresh failed, using existing file:', e.message);
    load();
  }
}

load(); // make the list available immediately at require time

// Set of index-constituent stock symbols (has tags, excludes currencies) —
// used to keep "biggest movers" to real companies, not illiquid penny junk.
let taggedCache = null;
let taggedForLen = -1;
function tagged() {
  if (taggedCache && taggedForLen === symbols.length) return taggedCache;
  taggedCache = new Set();
  for (const x of symbols) {
    if (x.tags && x.tags.length && !x.tags.includes('Currency')) taggedCache.add(x.s);
  }
  taggedForLen = symbols.length;
  return taggedCache;
}

module.exports = {
  all: () => symbols,
  count: () => symbols.length,
  tagged,
  ensureFresh, // server calls this on startup and on a daily timer
};
