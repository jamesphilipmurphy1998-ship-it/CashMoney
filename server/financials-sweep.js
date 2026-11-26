// financials-sweep.js — background fortnightly sweep of Financials,
// Analysis, and Statistics data for every symbol in the universe, so history
// keeps accumulating (see yahoo-financials.js's mergeTable/mergeByKey) even
// for stocks nobody happens to open. Without this, a symbol that isn't
// visited for a year would miss whatever quarters Yahoo's rolling window
// drops in the meantime — those periods would just be gone for good.
// (Statistics itself has no history to lose — it's just a live snapshot —
// but keeping it warm here means it's never stale on first open either.)
//
// Financials/analyst/statistics data only changes quarterly at most, so this
// doesn't need anything like the quote sweep's continuous pace — one full
// lap every two weeks is comfortably ahead of any reporting cadence. Each
// symbol still goes through yahoo-financials.js's normal 24h cache, so a
// stock a user already opened recently is skipped over (cheap no-op), not
// re-fetched.

const fs = require('fs');
const path = require('path');
const universe = require('./universe');
const yf = require('./yahoo-financials');

const SWEEP_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000; // fortnight
const SPACING_MS = 1500; // gentle pacing — same crumb-authenticated session as on-demand fetches, several requests per symbol

// Cursor + lap start persisted to disk so a server restart resumes where the
// sweep left off instead of losing its place. Without this, a restart mid-lap
// would silently restart the symbol list from the top (harmless — already-hot
// symbols are just a cheap cache-skip — but it also loses lapStartTs, so the
// fortnight wait between laps would never actually elapse on a frequently
// restarted server, and Yahoo would get re-swept far more often than intended).
const STATE_FILE = path.join(__dirname, '..', 'data', 'financials-sweep-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ cursor, lapStartTs })); } catch {}
}

let started = false;
let ok = 0;
let fail = 0;
let lastTs = 0;
let lastErr = '';
let cursor = 0;
let list = [];
let lapStartTs = 0;

// Only real companies report financials/analyst estimates — FX pairs and
// index/commodity levels (tagged 'Currency'/'Major Indices' in universe.js)
// have neither, so skip them rather than spend requests on guaranteed misses.
function buildList() {
  list = universe.all()
    .filter((x) => !(x.tags || []).some((t) => t === 'Currency' || t === 'Major Indices'))
    .map((x) => x.s);
}

function start() {
  if (started) return;
  started = true;
  buildList();
  const saved = loadState();
  // Only resume mid-list if the saved cursor still fits the current universe
  // size — a rebuilt/changed universe (new listings, delistings) makes a
  // stale index meaningless, so start that lap over rather than misapply it.
  if (saved && saved.lapStartTs && saved.cursor >= 0 && saved.cursor <= list.length) {
    cursor = saved.cursor;
    lapStartTs = saved.lapStartTs;
  } else {
    lapStartTs = Date.now();
  }
  console.log('[financials-sweep] starting fortnightly sweep of', list.length, 'symbols (resuming at', cursor, ')');
  const tick = async () => {
    if (cursor >= list.length) {
      // Lap finished ahead of the fortnight (likely, since most symbols are
      // skipped via the 24h cache) — wait out the remainder before looping.
      const wait = Math.max(0, SWEEP_INTERVAL_MS - (Date.now() - lapStartTs));
      setTimeout(() => {
        cursor = 0;
        buildList();
        lapStartTs = Date.now();
        saveState();
        tick();
      }, wait);
      return;
    }
    const symbol = list[cursor++];
    try {
      await yf.getFinancials(symbol);
      await yf.getAnalysis(symbol);
      await yf.getStatistics(symbol);
      await yf.getValuationHistory(symbol);
      ok++;
      lastTs = Date.now();
    } catch (e) {
      fail++;
      lastErr = String(e.message || e);
    }
    saveState();
    setTimeout(tick, SPACING_MS);
  };
  tick();
}

function status() {
  return { ok, fail, lastErr, lastTs, total: list.length, cursor, lapStartTs };
}

module.exports = { start, status };
