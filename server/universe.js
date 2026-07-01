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
  if (!KEY) return false;
  const [symRes, memberships] = await Promise.all([
    fetch(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${KEY}`),
    indexes.fetchMemberships(),
  ]);
  if (!symRes.ok) throw new Error(`finnhub symbols ${symRes.status}`);
  const data = await symRes.json();
  if (!Array.isArray(data)) throw new Error('unexpected symbols response');

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

// Refresh if the saved list is missing or older than a week; otherwise reuse.
async function ensureFresh() {
  if (ageMs() < MAX_AGE_MS) {
    load();
    console.log('[universe] loaded', symbols.length, 'symbols (file is fresh)');
    return;
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

module.exports = {
  all: () => symbols,
  count: () => symbols.length,
  ensureFresh, // server calls this on startup and on a daily timer
};
