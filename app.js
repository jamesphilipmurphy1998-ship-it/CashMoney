// app.js — UI wiring and rendering.

const PALETTE = ['#378add', '#1d9e75', '#7f77dd', '#d85a30', '#ef9f27', '#d4537e', '#639922'];

let state = { positions: [], notes: [] };

const $ = (sel) => document.querySelector(sel);

// Totals/values are shown in the user's chosen display currency.
const money = (n) => Currency.format(Currency.display, n, 0);
const money2 = (n) => Currency.format(Currency.display, n, 2);
const pct = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;
const signClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

// ---- Calculations -------------------------------------------------------

// Sharesies' cash-like imports (Wallet/Save/KiwiSaver — see getCashLikeHolding
// in server/sharesies.js) use synthetic tickers, not real market symbols:
// KIWISAVER.NZ, or CASH-<SLUG>.NZ (slug from the Save goal's name, e.g.
// "Holiday"). Recognizing the pattern (rather than persisting a separate
// flag) means it survives a reload with no DB schema change — it's derived
// straight from the ticker already stored on the position.
function cashLabel(ticker) {
  const t = String(ticker || '');
  if (t === 'KIWISAVER.NZ') return 'KiwiSaver';
  const m = /^CASH-(.+)\.NZ$/.exec(t);
  if (!m) return null;
  return m[1] === 'WALLET' ? 'Wallet' : m[1].charAt(0) + m[1].slice(1).toLowerCase();
}
const isCash = (p) => cashLabel(p.ticker) != null;

// Native (listing-currency) amounts, then converted to the display currency
// so a mixed-currency portfolio totals correctly.
const nativeCcy = (p) => Currency.of(p.ticker);
function positionValue(p) {
  return Currency.convert(Prices.getPrice(p) * Number(p.shares), nativeCcy(p), Currency.display);
}
function positionCost(p) {
  return Currency.convert(Number(p.cost) * Number(p.shares), nativeCcy(p), Currency.display);
}
function positionDayChange(p) {
  // Day $ move = today's value minus value at yesterday's close.
  const v = positionValue(p);
  const dp = Prices.getDayChange(p) / 100;
  const prev = v / (1 + dp);
  return v - prev;
}

function totals() {
  const value = state.positions.reduce((s, p) => s + positionValue(p), 0);
  const cost = state.positions.reduce((s, p) => s + positionCost(p), 0);
  const dayMove = state.positions.reduce((s, p) => s + positionDayChange(p), 0);
  const totalGain = value - cost;
  const prevValue = value - dayMove;
  return {
    value,
    cost,
    dayMove,
    dayPct: prevValue ? (dayMove / prevValue) * 100 : 0,
    totalGain,
    totalPct: cost ? (totalGain / cost) * 100 : 0,
  };
}

// ---- Rendering ----------------------------------------------------------

let ready = false; // becomes true once data is loaded, so renders don't save back during boot
let portfolios = []; // [{ id, name }]
let activePid = null; // id of the portfolio currently being viewed
const AGG = '__agg__'; // sentinel: the aggregated, read-only summary of every portfolio
const isAgg = () => activePid === AGG;

// ---- Browser back/forward -----------------------------------------------
// The app never touched history before this — every "page" (Home, a stock's
// detail page, Connectors, Profile, Research, Earnings Calendar, Compound
// Calculator, a portfolio tab) is just a JS-toggled overlay, so Back/Forward
// had nothing real to navigate through. Nav.push records one state object
// per view; a single popstate listener (applyView, below) replays whichever
// one the browser lands on. Every page module's own show() calls Nav.push
// at the top of its own function — one call site per page, not scattered
// across every place that happens to open it.
let restoringView = false; // true while applyView is replaying a popstate — Nav.push no-ops so it can't re-push a duplicate entry
const Nav = {
  // Guards against pushing the exact same view twice in a row (e.g. clicking
  // the same stock's row twice), which would otherwise bloat history with
  // entries Back has to click through without anything visibly changing.
  push(view) {
    if (restoringView) return;
    const cur = history.state;
    if (cur && view && cur.type === view.type && cur.sym === view.sym && cur.pid === view.pid) return;
    history.pushState(view, '');
  },
};
window.Nav = Nav;

function applyView(view) {
  restoringView = true;
  try {
    if (!view || view.type === 'portfolio') {
      if (window.StockPage) StockPage.close();
      if (window.ConnectorsPage) ConnectorsPage.close();
      if (window.ProfilePage) ProfilePage.close();
      if (window.ResearchPage) ResearchPage.close();
      if (window.EarningsCalendarPage) EarningsCalendarPage.close();
      if (window.CompoundPage) CompoundPage.close();
      if (window.SettingsPage) SettingsPage.close();
      if (window.HomePage) HomePage.close();
      selectPortfolio((view && view.pid) || AGG, { closeOverlays: false });
    } else if (view.type === 'home' && window.HomePage) {
      HomePage.show();
    } else if (view.type === 'stock' && window.StockPage) {
      StockPage.show(view.sym, view.opts || {});
    } else if (view.type === 'connectors' && window.ConnectorsPage) {
      ConnectorsPage.show();
    } else if (view.type === 'profile' && window.ProfilePage) {
      ProfilePage.show();
    } else if (view.type === 'research' && window.ResearchPage) {
      ResearchPage.show();
    } else if (view.type === 'earnings' && window.EarningsCalendarPage) {
      EarningsCalendarPage.show();
    } else if (view.type === 'compound' && window.CompoundPage) {
      CompoundPage.show();
    } else if (view.type === 'settings' && window.SettingsPage) {
      SettingsPage.show();
    }
  } finally {
    restoringView = false;
  }
}
window.addEventListener('popstate', (e) => applyView(e.state));

// When each portfolio's stock prices were last actually pulled live (not
// just re-rendered) — distinct from the generic "Updated" timestamp in the
// topbar, which fires on every render (position edits, note edits, etc.),
// not just price refreshes. Persisted to localStorage so it survives page
// reloads — this is "when did this ever last happen", not "this browser tab".
const getLastPriceRefresh = (pid) => Number(localStorage.getItem('cashmoney.lastPriceRefresh.' + pid)) || null;
const setLastPriceRefresh = (pid, ts) => localStorage.setItem('cashmoney.lastPriceRefresh.' + pid, String(ts));

function renderRefreshNote() {
  const el = $('#refresh-note');
  if (isAgg()) { el.textContent = ''; return; }
  const p = portfolios.find((x) => x.id === activePid);
  const parts = [];
  const priceTs = getLastPriceRefresh(activePid);
  parts.push(priceTs ? 'Stock prices last refreshed ' + new Date(priceTs).toLocaleString() : 'Stock prices not yet refreshed');
  if (p?.sharesies_linked) {
    parts.push(p.sharesies_synced_at ? 'Sharesies data last synced ' + new Date(p.sharesies_synced_at).toLocaleString() : 'Sharesies data not yet synced');
  }
  el.textContent = parts.join(' · ');
}

function render() {
  // Display currency is per-portfolio — scope it to whichever is being viewed.
  if (window.Currency) Currency.setScope(activePid);
  renderMetrics();
  renderHoldings();
  renderAllocation();
  renderNotes();
  renderSharesiesChart();
  renderSummaryChart();
  renderRefreshNote();
  $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  // The aggregate view spans many portfolios and is read-only — never save it back.
  if (ready && activePid && !isAgg()) Store.save(activePid, state).catch((e) => console.warn('Save failed:', e));
}

// ---- Sharesies performance chart ----------------------------------------
// A one-off snapshot taken at import time (see sharesies.js's
// getPortfolioHistory), saved on the portfolio row so it survives
// disconnecting Sharesies. Re-import to refresh it. Mirrors the sparkline
// pattern in stock.js, adapted for {date, value} points.
let sharesiesRange = 'All';
// Shared by every stored-history chart (Sharesies + the aggregate summary
// below) — same windows the per-stock chart uses (see stock.js's RANGE_MS).
const RANGE_MS = { '5D': 5 * 864e5, '1M': 30 * 864e5, '6M': 182 * 864e5, '1Y': 365 * 864e5, All: Infinity };
function rangeWindowStart(range) {
  if (range === 'YTD') return new Date(new Date().getFullYear(), 0, 1).getTime();
  const span = RANGE_MS[range] ?? Infinity;
  return span === Infinity ? -Infinity : Date.now() - span;
}

function fmtNZD(n) {
  return '$' + Math.round(n || 0).toLocaleString();
}
const fmtChartDateTime = (ts) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// ---- Live 1D/5D value curve ----------------------------------------------
// Computed live from each holding's own price series and summed — so this
// works for ANY portfolio, including one with no manually-recorded
// summary_history at all (a plain user-created portfolio, not just
// aggregate/Sharesies-linked ones). 1D uses today's real intraday minute
// bars; every other range (5D through All) replays /api/history's daily
// closes, which auto-backfill years of real Yahoo data the first time any
// symbol is ever priced (see server/server.js's /api/history route) — so a
// year-long chart doesn't require having actually opened the app daily for
// a year, just having held these stocks and having them priced at least once.
//
// Two unavoidable approximations, since there's no buy/sell transaction log
// to replay instead: (1) today's share count is applied across the whole
// window, so a past buy/sell isn't reflected before it happened; (2) cash-
// like positions (KiwiSaver, Sharesies Wallet/Save — see isCash) have no
// market price at all, so they contribute today's value flatly throughout.
async function computeLiveCurve(positions, range) {
  const real = positions.filter((p) => !isCash(p) && Number(p.shares) > 0);
  const bySymbol = new Map();
  for (const p of real) bySymbol.set(p.ticker, (bySymbol.get(p.ticker) || 0) + Number(p.shares));
  const symbols = [...bySymbol.keys()];
  const cashValue = positions.filter(isCash).reduce((s, p) => s + positionValue(p), 0);
  if (!symbols.length) return [];

  const from = rangeWindowStart(range);
  const seriesArr = await Promise.all(symbols.map(async (sym) => {
    try {
      if (range === '1D') {
        const r = await fetch('/api/intraday/' + encodeURIComponent(sym));
        const d = await r.json();
        return r.ok ? (d.points || []).sort((a, b) => a[0] - b[0]) : [];
      }
      const r = await fetch('/api/history/' + encodeURIComponent(sym));
      const d = await r.json();
      return (d.points || []).filter(([ts]) => ts >= from).sort((a, b) => a[0] - b[0]);
    } catch {
      return [];
    }
  }));

  const allTs = new Set();
  seriesArr.forEach((series) => series.forEach(([ts]) => allTs.add(ts)));
  const tsList = [...allTs].sort((a, b) => a - b);
  if (tsList.length < 2) return [];

  const cursors = symbols.map(() => 0);
  return tsList.map((ts) => {
    let total = cashValue;
    symbols.forEach((sym, idx) => {
      const series = seriesArr[idx];
      if (!series.length) return;
      let ci = cursors[idx];
      while (ci + 1 < series.length && series[ci + 1][0] <= ts) ci++;
      cursors[idx] = ci;
      total += Currency.convert(series[ci][1] * bySymbol.get(sym), Currency.of(sym), Currency.display);
    });
    return { ts, value: total };
  });
}

// Cached per context+range for 30s so the 15s price-refresh tick (see
// refreshPricesOnly) doesn't re-fetch every holding's full price series on
// every render — it just redraws the same points until the cache goes stale.
let liveChartGen = 0;
const liveCurveCache = new Map();
const LIVE_CURVE_TTL = 30000;
function renderLiveCurvePoints(plot, points, setHoverPts) {
  if (points.length < 2) {
    setHoverPts([]);
    plot.innerHTML = '<div class="sp-chart-msg">Not enough live data for this range yet.</div>';
    return;
  }
  const { svg, hoverPts } = buildValueChartSVG(points);
  setHoverPts(hoverPts);
  plot.innerHTML = svg;
}
async function drawLiveRangeChart(plotSel, setHoverPts, range, ctxKey) {
  const key = ctxKey + '|' + range;
  const plot = $(plotSel);
  const cached = liveCurveCache.get(key);
  if (cached && Date.now() - cached.at < LIVE_CURVE_TTL) {
    renderLiveCurvePoints(plot, cached.points, setHoverPts);
    return;
  }
  if (!cached) plot.innerHTML = '<div class="sp-chart-msg">Loading…</div>';
  const myGen = ++liveChartGen;
  const points = await computeLiveCurve(state.positions, range);
  if (myGen !== liveChartGen) return; // a newer draw superseded this one
  liveCurveCache.set(key, { points, at: Date.now() });
  renderLiveCurvePoints(plot, points, setHoverPts);
}

// Points past the last real Sharesies sync, estimated from live prices when
// Sharesies itself isn't connected (see extendSharesiesHistory). Display-only
// and in memory: never written to Supabase, rebuilt each time Update is
// pressed, and dropped as soon as a real Sharesies pull replaces the snapshot.
const sharesiesExtension = new Map(); // portfolio id -> [{ date, value, costBasis }]

function renderSharesiesChart() {
  const card = $('#sharesies-chart-card');
  const p = isAgg() ? null : portfolios.find((x) => x.id === activePid);
  const stored = p?.sharesies_history;
  if (!stored || !stored.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  if (sharesiesRange === '1D' || sharesiesRange === '5D') {
    $('#sharesies-chart-synced').textContent = '';
    drawLiveRangeChart('#sharesies-chart-plot', (h) => { sharesiesHoverPts = h; }, sharesiesRange, activePid);
    return;
  }
  const ext = sharesiesExtension.get(p.id) || [];
  const synced = p.sharesies_synced_at ? 'Synced ' + new Date(p.sharesies_synced_at).toLocaleDateString() : '';
  $('#sharesies-chart-synced').textContent = ext.length
    ? synced + ' · extended to ' + new Date(ext[ext.length - 1].date).toLocaleDateString() + ' from live prices (approx.)'
    : synced;
  drawSharesiesChart(ext.length ? stored.concat(ext) : stored);
}

// Sharesies' history is a snapshot, so it stops at your last sync (and the
// server forgets the Sharesies login whenever it restarts). When a real pull
// isn't possible, fill the gap from that last point to today using the same
// daily-close price history the Portfolio growth chart uses. Today's share
// counts are applied across the gap, and the estimate is scaled so it starts
// exactly where the stored line ended (no jump at the join) — hence approx.
async function extendSharesiesHistory(p) {
  const pts = (p.sharesies_history || [])
    .map((h) => ({ ts: new Date(h.date).getTime(), value: h.value, costBasis: h.costBasis }))
    .filter((x) => !Number.isNaN(x.ts))
    .sort((a, b) => a.ts - b.ts);
  if (!pts.length) return 0;
  const last = pts[pts.length - 1];
  const dayEnd = last.ts + 864e5;
  const curve = await computeLiveCurve(state.positions, 'All');
  const anchor = [...curve].reverse().find((c) => c.ts <= dayEnd);
  const ratio = anchor && anchor.value > 0 ? last.value / anchor.value : 1;
  // The price history keeps several samples per day (the live loop appends as
  // it prices), so keep only each day's last one — same density as Sharesies'.
  const perDay = new Map();
  for (const c of curve) if (c.ts > dayEnd) perDay.set(new Date(c.ts).toISOString().slice(0, 10), c);
  const fresh = [...perDay.values()]
    .map((c) => ({ date: new Date(c.ts).toISOString(), value: c.value * ratio, costBasis: last.costBasis }));
  if (fresh.length) sharesiesExtension.set(p.id, fresh);
  else sharesiesExtension.delete(p.id);
  return fresh.length;
}

async function updateSharesiesChart() {
  const p = isAgg() ? null : portfolios.find((x) => x.id === activePid);
  if (!p) return;
  const btn = $('#sharesies-chart-update');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  try {
    const res = await refreshSharesiesLink(); // real data, if Sharesies is connected
    if (res === 'updated') {
      sharesiesExtension.delete(p.id);
      showToast('Sharesies history updated', { done: true });
    } else {
      const n = await extendSharesiesHistory(p);
      showToast(n ? 'Extended to today from live prices (approx.)' : 'Already up to date', { done: true });
    }
  } catch (e) {
    console.warn('Graph update failed:', e);
    showToast('Could not update the graph', { done: true });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update';
    liveCurveCache.clear();
    render();
  }
}

let sharesiesHoverPts = []; // { ts, value, xf(0..1), yPix } for the current draw, like stock.js's hoverPts

// Shared by both value-over-time charts (Sharesies performance + the
// aggregated summary's growth chart below): turns [{ts, value}] into the
// line/area SVG plus the hover-lookup points, in a fixed 1000x240 viewBox.
function buildValueChartSVG(points) {
  // A single day's snapshot can't draw a line on its own — duplicate it out
  // to "now" so a short flat segment shows instead of nothing. Whatever data
  // exists should render; only a genuinely empty range should look blank.
  if (points.length === 1) {
    const only = points[0];
    points = [only, { ts: Math.max(only.ts + 1, Date.now()), value: only.value }];
  }
  const W = 1000, H = 240, pad = 8;
  let minP = Infinity, maxP = -Infinity;
  for (const { value } of points) { if (value < minP) minP = value; if (value > maxP) maxP = value; }
  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const spanT = t1 - t0 || 1;
  const spanP = maxP - minP || 1;
  const x = (ts) => ((ts - t0) / spanT) * W;
  const y = (v) => pad + (1 - (v - minP) / spanP) * (H - 2 * pad);
  let d = '';
  points.forEach(({ ts, value }, i) => { d += (i ? 'L' : 'M') + x(ts).toFixed(1) + ' ' + y(value).toFixed(1); });
  const hoverPts = points.map(({ ts, value }) => ({ ts, value, xf: (ts - t0) / spanT, yPix: y(value) }));
  const up = points[points.length - 1].value >= points[0].value;
  const col = up ? 'var(--up)' : 'var(--down)';
  const area = `M0 ${H} ` + d.replace(/^M/, 'L') + ` L${W} ${H} Z`;
  const svg =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path class="sp-chart-area" d="${area}" fill="${col}"/>` +
    `<path class="sp-chart-line" d="${d}" stroke="${col}"/>` +
    `</svg>` +
    `<div class="sp-cross" hidden></div><div class="sp-dot" hidden></div><div class="sp-hoverbox" hidden></div>`;
  return { svg, hoverPts };
}

// Same shape as buildValueChartSVG but plots a second "contributed" series
// (blue, no fill) alongside the main value line — used by the Compound
// Calculator to show growth against the amount actually put in.
function buildCompoundChartSVG(points) {
  const W = 1000, H = 240, pad = 8;
  let minP = Infinity, maxP = -Infinity;
  for (const { value, contributed } of points) {
    if (value < minP) minP = value; if (value > maxP) maxP = value;
    if (contributed < minP) minP = contributed; if (contributed > maxP) maxP = contributed;
  }
  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const spanT = t1 - t0 || 1;
  const spanP = maxP - minP || 1;
  const x = (ts) => ((ts - t0) / spanT) * W;
  const y = (v) => pad + (1 - (v - minP) / spanP) * (H - 2 * pad);
  let dValue = '', dContrib = '';
  points.forEach(({ ts, value, contributed }, i) => {
    dValue += (i ? 'L' : 'M') + x(ts).toFixed(1) + ' ' + y(value).toFixed(1);
    dContrib += (i ? 'L' : 'M') + x(ts).toFixed(1) + ' ' + y(contributed).toFixed(1);
  });
  const hoverPts = points.map(({ ts, value, contributed }) => ({ ts, value, contributed, xf: (ts - t0) / spanT, yPix: y(value) }));
  const area = `M0 ${H} ` + dValue.replace(/^M/, 'L') + ` L${W} ${H} Z`;
  const svg =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path class="sp-chart-area" d="${area}" fill="var(--up)"/>` +
    `<path class="sp-chart-line calc-line-contrib" d="${dContrib}"/>` +
    `<path class="sp-chart-line" d="${dValue}" stroke="var(--up)"/>` +
    `</svg>` +
    `<div class="sp-cross" hidden></div><div class="sp-dot" hidden></div><div class="sp-hoverbox" hidden></div>`;
  return { svg, hoverPts };
}

function drawSharesiesChart(history) {
  const plot = $('#sharesies-chart-plot');
  const pts = history
    .map((h) => ({ ts: new Date(h.date).getTime(), value: h.value }))
    .filter(({ ts }) => !Number.isNaN(ts))
    .sort((a, b) => a.ts - b.ts);
  const from = rangeWindowStart(sharesiesRange);
  const windowed = pts.filter(({ ts }) => ts >= from);
  if (!windowed.length) {
    sharesiesHoverPts = [];
    plot.innerHTML = '<div class="sp-chart-msg">Not enough history for this range.</div>';
    return;
  }
  // No summary stat here — the correct one (cost-basis aware) is already the
  // "Total gain" metric card above. Re-deriving a range-specific figure from
  // raw value here previously double-counted deposits as gains.
  const { svg, hoverPts } = buildValueChartSVG(windowed);
  sharesiesHoverPts = hoverPts;
  plot.innerHTML = svg;
}

// Hover crosshair + tooltip — same pattern as the stock page (see onHover in
// stock.js), adapted for portfolio value + calendar dates. Shared by both
// value-over-time charts; each just supplies its own points + formatter.
const fmtSharesiesDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
// renderBox(best) returns the hover tooltip's innerHTML — lets callers with
// different point shapes (single value vs. value+contributed) each supply
// their own tooltip layout while sharing the crosshair/positioning logic.
function bindValueChartHover(plotSel, getHoverPts, renderBox) {
  const plot = $(plotSel);
  plot.addEventListener('mousemove', (e) => {
    const pts = getHoverPts();
    const cross = plot.querySelector('.sp-cross');
    const dot = plot.querySelector('.sp-dot');
    const box = plot.querySelector('.sp-hoverbox');
    if (!pts.length || !cross || !dot || !box) return;
    const rect = plot.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    let best = pts[0];
    let bd = Infinity;
    for (const p of pts) { const dd = Math.abs(p.xf - fx); if (dd < bd) { bd = dd; best = p; } }
    const left = best.xf * 100;
    cross.style.left = left + '%'; cross.hidden = false;
    dot.style.left = left + '%'; dot.style.top = best.yPix + 'px'; dot.hidden = false;
    box.innerHTML = renderBox(best);
    box.style.left = left + '%';
    box.style.transform = best.xf < 0.12 ? 'translateX(0)' : best.xf > 0.88 ? 'translateX(-100%)' : 'translateX(-50%)';
    box.hidden = false;
  });
  plot.addEventListener('mouseleave', () => {
    plot.querySelectorAll('.sp-cross, .sp-dot, .sp-hoverbox').forEach((el) => { el.hidden = true; });
  });
}
bindValueChartHover('#sharesies-chart-plot', () => sharesiesHoverPts, (best) => {
  const dateLabel = (sharesiesRange === '1D' || sharesiesRange === '5D') ? fmtChartDateTime(best.ts) : fmtSharesiesDate(best.ts);
  return `<b>${fmtNZD(best.value)}</b><span>${dateLabel}</span>`;
});

$('#sharesies-chart-update').addEventListener('click', updateSharesiesChart);
// Portfolio growth is already computed live from price history, so "refresh"
// just throws away the 30s cache and redraws with freshly fetched series.
$('#summary-chart-refresh').addEventListener('click', () => {
  liveCurveCache.clear();
  renderSummaryChart();
});

$('#sharesies-chart-ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('.sp-range');
  if (!btn) return;
  sharesiesRange = btn.dataset.range;
  $('#sharesies-chart-ranges').querySelectorAll('.sp-range').forEach((b) => b.classList.toggle('active', b === btn));
  renderSharesiesChart();
});

// ---- Summary growth chart -----------------------------------------------
// The aggregated "Portfolio's summary" has no single external source to pull
// history from (unlike a Sharesies-linked portfolio), so this is a daily
// snapshot the app records itself — one row per day in Supabase's
// summary_history table (see store.js), starting the day this shipped
// ("day 0"). Stored in USD so it stays comparable if the display currency
// is ever changed later; converted to the current display currency here.
// A plain (non-aggregate, non-Sharesies) portfolio has no stored history at
// all, so this card also doubles as its chart — just live 1D/5D, no "All".
let summaryHistory = [];
let summaryHoverPts = [];
let summaryRange = 'All';

async function loadSummaryChartData() {
  try { summaryHistory = await Store.loadSummaryHistory(); } catch (e) { console.warn('Failed to load summary history:', e); summaryHistory = []; }
  renderSummaryChart();
}

function renderSummaryChart() {
  const card = $('#summary-chart-card');
  const agg = isAgg();
  const p = agg ? null : portfolios.find((x) => x.id === activePid);
  const usesSharesies = !agg && p?.sharesies_history?.length > 0; // the Sharesies chart handles this portfolio instead
  const hasHoldings = state.positions.some((x) => !isCash(x));
  if (usesSharesies || !hasHoldings) { card.hidden = true; return; }
  card.hidden = false;

  // Every range is now computed live from each holding's own backfilled
  // price history (see computeLiveCurve) — no longer gated to 1D/5D-only for
  // a plain (non-aggregate) portfolio, since that computation never
  // depended on the aggregate-only summary_history table to begin with.
  $('#summary-chart-ranges').querySelectorAll('.sp-range').forEach((b) => { b.hidden = false; });
  $('#summary-chart-ranges').querySelectorAll('.sp-range').forEach((b) => b.classList.toggle('active', b.dataset.range === summaryRange));
  $('#summary-chart-synced').textContent = '';
  drawLiveRangeChart('#summary-chart-plot', (h) => { summaryHoverPts = h; }, summaryRange, agg ? 'agg' : activePid);
}
$('#summary-chart-ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('.sp-range');
  if (!btn || btn.hidden) return;
  summaryRange = btn.dataset.range;
  renderSummaryChart();
});

bindValueChartHover('#summary-chart-plot', () => summaryHoverPts, (best) => {
  const dateLabel = (summaryRange === '1D' || summaryRange === '5D') ? fmtChartDateTime(best.ts) : fmtSharesiesDate(best.ts);
  return `<b>${money(best.value)}</b><span>${dateLabel}</span>`;
});

// Total portfolio value in USD (not the display currency, which can change
// later) — the stable unit summary_history is stored in.
function totalValueUSD() {
  return state.positions.reduce((s, p) => s + Currency.convert(Prices.getPrice(p) * Number(p.shares), nativeCcy(p), 'USD'), 0);
}

// Records (upserts) today's total as this row's value — called whenever the
// summary view loads, throttled so navigating back and forth doesn't spam
// writes. Safe to call often: same-day calls just update the same row.
let lastSummarySnapshotAt = 0;
async function recordSummarySnapshot() {
  if (!isAgg()) return;
  const now = Date.now();
  if (now - lastSummarySnapshotAt < 60000) return;
  lastSummarySnapshotAt = now;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const value = totalValueUSD();
    await Store.recordSummarySnapshot(today, value);
    const idx = summaryHistory.findIndex((h) => h.date === today);
    if (idx >= 0) summaryHistory[idx].value = value;
    else summaryHistory.push({ date: today, value });
    renderSummaryChart();
  } catch (e) {
    console.warn('Failed to record summary snapshot:', e);
  }
}

// Split a display-currency amount into { symbol, number } so the Total value
// card can make the currency symbol a clickable dropdown trigger.
function displayParts(n) {
  let symbol = '';
  let number = '';
  try {
    for (const p of new Intl.NumberFormat('en-US', { style: 'currency', currency: Currency.display, maximumFractionDigits: 0 }).formatToParts(n || 0)) {
      if (p.type === 'currency') symbol += p.value;
      else number += p.value;
    }
  } catch { symbol = Currency.display; number = String(Math.round(n || 0)); }
  return { symbol, number };
}
const ccySymbol = (code) => displayCode(code).symbol;
function displayCode(code) {
  const prev = Currency.display;
  Currency.display = code;
  const s = displayParts(0).symbol;
  Currency.display = prev;
  return { symbol: s };
}

function renderMetrics() {
  const t = totals();
  const dp = displayParts(t.value);
  const menu = `<span class="ccy-menu" id="ccy-menu" hidden>${Currency.OPTIONS
    .map((c) => `<button class="ccy-item ${c === Currency.display ? 'active' : ''}" data-ccy="${c}"><span class="ccy-item-sym">${ccySymbol(c)}</span>${c}</button>`)
    .join('')}</span>`;
  const totalValueHtml = `<span class="ccy-trigger" data-ccy-trigger role="button" title="Change display currency">${dp.symbol}<span class="ccy-caret">▾</span></span>${dp.number}${menu}`;
  const cards = [
    { label: 'Total value', value: totalValueHtml, cls: '' },
    {
      label: 'Today',
      value: `${t.dayMove >= 0 ? '+' : '−'}${money(Math.abs(t.dayMove))} <span class="sub">${pct(t.dayPct)}</span>`,
      cls: signClass(t.dayMove),
    },
    {
      label: 'Total gain',
      value: `${t.totalGain >= 0 ? '+' : '−'}${money(Math.abs(t.totalGain))} <span class="sub">${pct(t.totalPct)}</span>`,
      cls: signClass(t.totalGain),
    },
  ];
  $('#metrics').innerHTML = cards
    .map(
      (c) => `<div class="metric">
        <p class="label">${c.label}</p>
        <p class="value ${c.cls}">${c.value}</p>
      </div>`
    )
    .join('');
}

// Manual drag order: a per-portfolio list of position ids, kept in
// localStorage rather than a new Supabase column — positions are saved via
// upsert with no ORDER BY on load (see store.js), so row order isn't
// guaranteed to round-trip through the database anyway. This is a display
// preference, same tier as the display-currency/allocation-format settings
// already stored this way.
const ORDER_KEY = 'cashmoney.holdingsOrder';
function loadOrderMap() {
  try { return JSON.parse(localStorage.getItem(ORDER_KEY)) || {}; } catch { return {}; }
}
function getManualOrder(pid) {
  return loadOrderMap()[pid] || null;
}
function setManualOrder(pid, ids) {
  const map = loadOrderMap();
  map[pid] = ids;
  localStorage.setItem(ORDER_KEY, JSON.stringify(map));
}
// Applies the saved order (dragged ids first, in that order) then appends
// anything not in it (new positions since the last drag) in their existing order.
function applyManualOrder(positions, pid) {
  const order = getManualOrder(pid);
  if (!order || !order.length) return positions;
  const byId = new Map(positions.map((p) => [p.id, p]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  for (const p of positions) if (!order.includes(p.id)) ordered.push(p);
  return ordered;
}

// Same idea, for the order of the portfolio tabs themselves — Store.listPortfolios
// only has created_at to sort by, no user-facing "position" column, so this is
// a local display preference rather than a Supabase migration.
const PF_ORDER_KEY = 'cashmoney.portfolioOrder';
function applyPortfolioOrder(list) {
  let order = [];
  try { order = JSON.parse(localStorage.getItem(PF_ORDER_KEY)) || []; } catch {}
  if (!order.length) return list;
  const byId = new Map(list.map((p) => [p.id, p]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  for (const p of list) if (!order.includes(p.id)) ordered.push(p);
  return ordered;
}
function savePortfolioOrder() {
  localStorage.setItem(PF_ORDER_KEY, JSON.stringify(portfolios.map((p) => p.id)));
}

// Same idea again, for the Connectors page's "Live coverage" table rows —
// purely a display preference (the table's actual data is unaffected either
// way), so localStorage rather than anything server-side.
const COVERAGE_ORDER_KEY = 'cashmoney.coverageOrder';
function applyCoverageOrder(tags) {
  let order = [];
  try { order = JSON.parse(localStorage.getItem(COVERAGE_ORDER_KEY)) || []; } catch {}
  if (!order.length) return tags;
  const ordered = order.filter((t) => tags.includes(t));
  for (const t of tags) if (!ordered.includes(t)) ordered.push(t);
  return ordered;
}
function saveCoverageOrder(tags) {
  localStorage.setItem(COVERAGE_ORDER_KEY, JSON.stringify(tags));
}

// Per-tab colour, set via right-click (see the contextmenu handler below).
// Local display preference, same tier as the ordering above — no Supabase
// column for it.
const TAB_COLOR_KEY = 'cashmoney.tabColors';
function getTabColors() {
  try { return JSON.parse(localStorage.getItem(TAB_COLOR_KEY)) || {}; } catch { return {}; }
}
function setTabColor(pid, color) {
  const map = getTabColors();
  if (color) map[pid] = color; else delete map[pid];
  localStorage.setItem(TAB_COLOR_KEY, JSON.stringify(map));
}

// Column-header sort: click a header to sort highest-first, click it again
// for lowest-first, click a different header to start that column fresh
// (highest-first). Purely a display order — never touches state.positions,
// so it doesn't affect what gets saved.
let holdingsSort = { col: null, dir: 'desc' };
const HOLDINGS_SORT_VALUE = {
  ticker: (p) => (isCash(p) ? cashLabel(p.ticker) : p.ticker).toLowerCase(),
  shares: (p) => Number(p.shares) || 0,
  cost: (p) => Number(p.cost) || 0,
  price: (p) => Prices.getPrice(p),
  day: (p) => Prices.getDayChange(p),
  value: (p) => positionValue(p),
  gain: (p) => positionValue(p) - positionCost(p),
};
$('#holdings-head').addEventListener('click', (e) => {
  const th = e.target.closest('[data-sort]');
  if (!th) return;
  const col = th.dataset.sort;
  holdingsSort = { col, dir: holdingsSort.col === col && holdingsSort.dir === 'desc' ? 'asc' : 'desc' };
  renderHoldings();
});
function renderSortHeader() {
  for (const th of $('#holdings-head').querySelectorAll('[data-sort]')) {
    const active = th.dataset.sort === holdingsSort.col;
    th.classList.toggle('sorted', active);
    th.querySelector('.sort-arrow')?.remove();
    if (active) th.insertAdjacentHTML('beforeend', `<span class="sort-arrow">${holdingsSort.dir === 'desc' ? '↓' : '↑'}</span>`);
  }
}

function renderHoldings() {
  const body = $('#holdings-body');
  const empty = $('#holdings-empty');
  $('#holdings-count').textContent = state.positions.length
    ? `${state.positions.length} position${state.positions.length > 1 ? 's' : ''}`
    : '';
  renderSortHeader();

  if (!state.positions.length) {
    body.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const ordered = isAgg() ? state.positions : applyManualOrder(state.positions, activePid);
  const rows = holdingsSort.col
    ? [...ordered].sort((a, b) => {
        const get = HOLDINGS_SORT_VALUE[holdingsSort.col];
        const av = get(a), bv = get(b);
        const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
        return holdingsSort.dir === 'desc' ? -cmp : cmp;
      })
    : ordered;

  body.innerHTML = rows
    .map((p) => {
      const value = positionValue(p);
      const gain = value - positionCost(p);
      const gainPct = positionCost(p) ? (gain / positionCost(p)) * 100 : 0;
      const day = Prices.getDayChange(p);
      const cash = isCash(p);
      // Company name from the universe (e.g. 1801.T -> Taisei Corporation).
      // Cash-like Sharesies imports (Wallet/Save/KiwiSaver) show their plain
      // English label instead — they're not real tickers, so the market
      // universe has nothing to look up (see getCashLikeHolding in sharesies.js).
      const name = cash ? cashLabel(p.ticker) : (window.Market && Market.get(p.ticker) && Market.get(p.ticker).n) || '';
      // Dragging only reorders the natural (unsorted) list — while a column
      // sort is active the row order is computed, not stored, so there's
      // nothing meaningful to drag into.
      const canDrag = !isAgg() && !holdingsSort.col;
      return `<tr data-id="${p.id}">
        <td class="drag-handle" draggable="${canDrag}" title="${canDrag ? 'Drag to reorder' : 'Clear the column sort to reorder'}">⠿</td>
        <td><span class="sym">${cash ? esc(name) : esc(p.ticker)}</span>${!cash ? `<img class="mini-logo" data-logo="${esc(p.ticker)}" alt="" hidden onerror="this.hidden=true" />` : ''}${!cash && name ? `<span class="h-name">${esc(name)}</span>` : ''}</td>
        <td class="num">${cash ? '—' : fmtShares(p.shares)}</td>
        <td class="num">${window.fmtMoney(p.ticker, p.cost)}</td>
        <td class="num">${window.fmtMoney(p.ticker, Prices.getPrice(p))}</td>
        <td class="num ${cash ? '' : signClass(day)}">${cash ? '—' : pct(day)}</td>
        <td class="num">${money(value)}</td>
        <td class="num ${signClass(gain)}">${gain >= 0 ? '+' : '−'}${money(Math.abs(gain))} <span class="muted">${pct(gainPct)}</span></td>
        <td class="row-actions"><button class="icon-btn" data-del="${p.id}" title="Remove" aria-label="Remove ${esc(p.ticker)}">×</button></td>
      </tr>`;
    })
    .join('');
  loadHoldingLogos(rows.filter((p) => !isCash(p)).map((p) => p.ticker));
}

// ---- Mini holdings-table logos -------------------------------------------
// The same Finnhub company logo the stock page shows, small, next to each
// ticker in the holdings table. Cached client-side (logos don't change) so
// price-refresh re-renders and portfolio switches don't re-fetch them.
const logoCache = new Map(); // ticker -> url | null (null = known to have none)
function applyHoldingLogos() {
  document.querySelectorAll('#holdings-body .mini-logo[data-logo]').forEach((img) => {
    const url = logoCache.get(img.dataset.logo);
    if (url) { img.src = url; img.hidden = false; }
  });
}
async function loadHoldingLogos(tickers) {
  const missing = [...new Set(tickers)].filter((t) => !logoCache.has(t));
  if (!missing.length) { applyHoldingLogos(); return; }
  try {
    const r = await fetch('/api/logos?symbols=' + encodeURIComponent(missing.join(',')));
    const d = await r.json();
    missing.forEach((t) => logoCache.set(t, d[t] || null));
  } catch {
    missing.forEach((t) => logoCache.set(t, null));
  }
  applyHoldingLogos();
}

// Allocation is split by individual stock (ticker), shown as a Bar or a Pie —
// chosen via the Format dropdown and remembered.
let allocFormat = localStorage.getItem('cashmoney.allocFormat') || 'bar';
let allocData = localStorage.getItem('cashmoney.allocData') || 'pct'; // 'pct' | 'value'

function renderAllocation() {
  const bar = $('#alloc-bar');
  const pie = $('#alloc-pie');
  const legend = $('#alloc-legend');
  const t = totals();
  if (!t.value) {
    bar.innerHTML = '';
    pie.innerHTML = '';
    bar.hidden = pie.hidden = true;
    legend.innerHTML = '<span class="alloc-empty">Add positions to see allocation.</span>';
    return;
  }
  // Sum by ticker (so the same stock across linked portfolios combines).
  const groups = {};
  for (const p of state.positions) {
    const key = (p.ticker || '—').trim().toUpperCase() || '—';
    groups[key] = (groups[key] || 0) + positionValue(p);
  }
  const rows = Object.entries(groups)
    .sort((a, b) => b[1] - a[1])
    .map(([name, val], i) => ({ name, val, share: (val / t.value) * 100, color: PALETTE[i % PALETTE.length] }));

  const isPie = allocFormat === 'pie';
  bar.hidden = isPie;
  pie.hidden = !isPie;

  if (isPie) pie.innerHTML = pieSvg(rows);
  else bar.innerHTML = rows.map((r) => `<span style="width:${r.share}%;background:${r.color}"></span>`).join('');

  legend.innerHTML = rows
    .map(
      (r) => `<div class="row">
        <span class="name"><span class="swatch" style="background:${r.color}"></span>${esc(r.name)}</span>
        <span>${allocData === 'value' ? money(r.val) : r.share.toFixed(0) + '%'}</span>
      </div>`
    )
    .join('');
}

// Build a full <svg> pie for the allocation rows (shares already sum to 100).
// Returned as an <svg> string set on a plain <div> so the HTML parser creates
// real SVG-namespaced nodes (setting innerHTML on an <svg> element does not).
function pieSvg(rows) {
  const cx = 100, cy = 100, r = 96;
  const tipAttr = (row) => `data-tip="${esc(row.name)} — ${row.share.toFixed(1)}% (${esc(money(row.val))})"`;
  let inner;
  if (rows.length === 1) {
    inner = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${rows[0].color}" ${tipAttr(rows[0])}></circle>`;
  } else {
    let ang = -Math.PI / 2; // start at 12 o'clock
    inner = rows
      .map((row) => {
        const slice = (row.share / 100) * Math.PI * 2;
        const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
        ang += slice;
        const x2 = cx + r * Math.cos(ang), y2 = cy + r * Math.sin(ang);
        const large = slice > Math.PI ? 1 : 0;
        return `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${row.color}" ${tipAttr(row)}></path>`;
      })
      .join('');
  }
  // A separate stroke-only circle drawn on top of the slices, rather than
  // stroking each slice path itself — stroking the slices would also outline
  // the straight edges between them, which isn't wanted, just the outer rim.
  // var(--text) rather than a hardcoded black — on the dark theme, #000
  // against the already near-black card background was essentially
  // invisible no matter how thick. --text adapts to whichever theme is active.
  const outline = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--text)" stroke-width="3"></circle>`;
  return `<svg viewBox="0 0 200 200" width="220" height="220" aria-hidden="true">${inner}${outline}</svg>`;
}

// Follow-cursor tooltip for the allocation pie — SVG <title> has an
// unhelpfully long native hover delay, so we build our own like the chart
// hoverbox (see onHover in stock.js). The label sits just outside the pie's
// edge, on the same line from the center through the cursor, with a thin
// connector line back to the cursor point (like a data-label leader line).
(() => {
  const wrap = document.querySelector('.alloc-pie-wrap');
  const tip = $('#pie-tip');
  const lineSvg = $('#pie-tip-line');
  const line = lineSvg?.querySelector('line');
  if (!wrap || !tip || !lineSvg || !line) return;
  wrap.addEventListener('mousemove', (e) => {
    const el = e.target.closest('path, circle');
    if (!el || !el.dataset.tip) { tip.hidden = true; lineSvg.hidden = true; return; }
    const svgEl = el.ownerSVGElement;
    const wrapRect = wrap.getBoundingClientRect();
    const svgRect = svgEl.getBoundingClientRect();
    const cx = svgRect.left + svgRect.width / 2 - wrapRect.left;
    const cy = svgRect.top + svgRect.height / 2 - wrapRect.top;
    const mx = e.clientX - wrapRect.left;
    const my = e.clientY - wrapRect.top;
    let dx = mx - cx, dy = my - cy;
    const dist = Math.hypot(dx, dy) || 1;
    dx /= dist; dy /= dist;
    const outR = svgRect.width / 2 + 26; // just outside the pie's edge
    const anchorX = cx + dx * outR;
    const anchorY = cy + dy * outR;

    tip.textContent = el.dataset.tip;
    tip.style.left = anchorX + 'px';
    tip.style.top = anchorY + 'px';
    tip.hidden = false;

    line.setAttribute('x1', mx);
    line.setAttribute('y1', my);
    line.setAttribute('x2', anchorX);
    line.setAttribute('y2', anchorY);
    lineSvg.hidden = false;
  });
  wrap.addEventListener('mouseleave', () => { tip.hidden = true; lineSvg.hidden = true; });

  // Click a slice to outline just that one; click it again (or re-render) clears it.
  wrap.addEventListener('click', (e) => {
    const el = e.target.closest('path, circle');
    const svgEl = wrap.querySelector('svg.alloc-pie-svg') || wrap.querySelector('.alloc-pie svg');
    const prev = svgEl?.querySelector('.pie-selected');
    if (prev) prev.classList.remove('pie-selected');
    if (el && el.dataset.tip && el !== prev) el.classList.add('pie-selected');
  });
})();

// Format dropdown (Bar / Pie) for the allocation card.
const fmtMenu = $('#fmt-menu');
$('#fmt-label').textContent = allocFormat === 'pie' ? 'Pie' : 'Bar';
$('#fmt-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  fmtMenu.hidden = !fmtMenu.hidden;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.fmt-dd')) fmtMenu.hidden = true;
});
fmtMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.fmt-item');
  if (!item) return;
  allocFormat = item.dataset.fmt;
  localStorage.setItem('cashmoney.allocFormat', allocFormat);
  $('#fmt-label').textContent = allocFormat === 'pie' ? 'Pie' : 'Bar';
  fmtMenu.hidden = true;
  renderAllocation();
});

// Data dropdown (Percentage / Value) for the allocation legend.
const dataMenu = $('#data-menu');
const dataLabel = () => (allocData === 'value' ? 'Value' : 'Percentage');
$('#data-label').textContent = dataLabel();
$('#data-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  dataMenu.hidden = !dataMenu.hidden;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#data-dd')) dataMenu.hidden = true;
});
dataMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.fmt-item');
  if (!item) return;
  allocData = item.dataset.data;
  localStorage.setItem('cashmoney.allocData', allocData);
  $('#data-label').textContent = dataLabel();
  dataMenu.hidden = true;
  renderAllocation();
});

function renderNotes() {
  const wrap = $('#notes');
  if (!state.notes.length) {
    wrap.innerHTML = '<span class="notes-empty">No research notes yet.</span>';
    return;
  }
  wrap.innerHTML = state.notes
    .map(
      (n) => `<div class="note" data-note="${n.id}">
        <p class="n-title">${esc(n.title)}</p>
        <p class="n-body">${esc(n.body || '')}</p>
      </div>`
    )
    .join('');
}

// ---- Helpers ------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtShares(n) {
  const num = Number(n);
  return Number.isInteger(num) ? num.toString() : num.toFixed(2);
}

// ---- Position dialog ----------------------------------------------------

const posDialog = $('#position-dialog');
let editingId = null;

function openPosition(p) {
  editingId = p ? p.id : null;
  $('#position-title').textContent = p ? 'Edit position' : 'Add position';
  $('#f-ticker').value = p ? p.ticker : '';
  $('#f-shares').value = p ? p.shares : '';
  $('#f-cost').value = p ? p.cost : '';
  $('#f-price').value = p ? p.price : '';
  $('#f-day').value = p ? p.day : '';
  $('#f-category').value = p ? p.category || '' : '';
  posDialog.showModal();
  $('#f-ticker').focus();
}

$('#add-btn').addEventListener('click', () => openPosition(null));
$('#position-cancel').addEventListener('click', () => posDialog.close());

$('#position-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = {
    ticker: $('#f-ticker').value.trim().toUpperCase(),
    shares: parseFloat($('#f-shares').value) || 0,
    cost: parseFloat($('#f-cost').value) || 0,
    price: parseFloat($('#f-price').value) || 0,
    day: parseFloat($('#f-day').value) || 0,
    category: $('#f-category').value.trim(),
  };
  if (!data.ticker) return;
  if (editingId) {
    const p = state.positions.find((x) => x.id === editingId);
    if (p) Object.assign(p, data);
  } else {
    state.positions.push({ id: Store.id(), ...data });
  }
  posDialog.close();
  render();
});

// A single click on a row opens that stock's own page (Summary tab) — the
// same as clicking it anywhere else in the app (Search, ticker strip, etc).
// Editing shares/cost is now a double-click or right-click on the row
// instead, so it doesn't fight with just wanting to look up the stock.
$('#holdings-body').addEventListener('click', (e) => {
  if (e.target.closest('.drag-handle')) return; // a drag, not a click-through
  const delId = e.target.getAttribute('data-del');
  if (delId) {
    if (isAgg()) return; // read-only aggregate: no delete
    const p = state.positions.find((x) => x.id === delId);
    const label = p ? esc(p.ticker) : 'this holding';
    if (!confirm(`Remove ${label} from this portfolio? This can't be undone.`)) return;
    state.positions = state.positions.filter((x) => x.id !== delId);
    render();
    return;
  }
  const row = e.target.closest('tr[data-id]');
  if (row) {
    const p = state.positions.find((x) => x.id === row.dataset.id);
    if (p && !isCash(p) && window.StockPage) StockPage.show(p.ticker);
  }
});
function editRowAt(e) {
  if (isAgg()) return; // read-only aggregate: no edit
  if (e.target.closest('.drag-handle') || e.target.getAttribute('data-del')) return;
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const p = state.positions.find((x) => x.id === row.dataset.id);
  if (p) openPosition(p);
}
$('#holdings-body').addEventListener('dblclick', editRowAt);
$('#holdings-body').addEventListener('contextmenu', (e) => {
  if (e.target.closest('tr[data-id]')) e.preventDefault();
  editRowAt(e);
});

// Drag-to-reorder: grab the handle, drop on another row to move the dragged
// one before/after it depending which half of the row the cursor is over.
// Only touches display order (see applyManualOrder above) — never the
// underlying state.positions array, so it can't corrupt what gets saved.
let dragId = null;
const holdingsBody = $('#holdings-body');
holdingsBody.addEventListener('dragstart', (e) => {
  const handle = e.target.closest('.drag-handle');
  const row = handle && handle.closest('tr[data-id]');
  if (!row || handle.draggable !== true) { e.preventDefault(); return; }
  dragId = row.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  row.classList.add('dragging');
});
holdingsBody.addEventListener('dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  const row = e.target.closest('tr[data-id]');
  if (!row || row.dataset.id === dragId) return;
  const before = e.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
  holdingsBody.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach((r) => r.classList.remove('drag-over-top', 'drag-over-bottom'));
  row.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
});
holdingsBody.addEventListener('drop', (e) => {
  e.preventDefault();
  const row = e.target.closest('tr[data-id]');
  holdingsBody.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach((r) => r.classList.remove('drag-over-top', 'drag-over-bottom'));
  if (!dragId || !row || row.dataset.id === dragId) return;
  const before = e.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
  const order = applyManualOrder(state.positions, activePid).map((p) => p.id);
  const from = order.indexOf(dragId);
  order.splice(from, 1);
  const to = order.indexOf(row.dataset.id) + (before ? 0 : 1);
  order.splice(to, 0, dragId);
  setManualOrder(activePid, order);
  renderHoldings();
});
holdingsBody.addEventListener('dragend', () => {
  dragId = null;
  holdingsBody.querySelectorAll('.dragging, .drag-over-top, .drag-over-bottom').forEach((r) => r.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom'));
});

// ---- Note dialog --------------------------------------------------------

const noteDialog = $('#note-dialog');
let editingNote = null;

function openNote(n) {
  editingNote = n ? n.id : null;
  $('#note-title').textContent = n ? 'Edit note' : 'New note';
  $('#n-title').value = n ? n.title : '';
  $('#n-body').value = n ? n.body || '' : '';
  $('#note-delete').hidden = !n;
  noteDialog.showModal();
  $('#n-title').focus();
}

$('#add-note-btn').addEventListener('click', () => openNote(null));
$('#note-cancel').addEventListener('click', () => noteDialog.close());

$('#note-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = { title: $('#n-title').value.trim(), body: $('#n-body').value.trim() };
  if (!data.title) return;
  if (editingNote) {
    const n = state.notes.find((x) => x.id === editingNote);
    if (n) Object.assign(n, data);
  } else {
    state.notes.unshift({ id: Store.id(), ...data });
  }
  noteDialog.close();
  render();
});

$('#note-delete').addEventListener('click', () => {
  state.notes = state.notes.filter((n) => n.id !== editingNote);
  noteDialog.close();
  render();
});

$('#notes').addEventListener('click', (e) => {
  if (isAgg()) return; // read-only aggregate
  const card = e.target.closest('.note[data-note]');
  if (card) {
    const n = state.notes.find((x) => x.id === card.dataset.note);
    if (n) openNote(n);
  }
});

// ---- Refresh (live-data hook) -------------------------------------------

// If the open portfolio was ever imported from Sharesies (it has a saved
// sharesies_history snapshot), Refresh also re-pulls current shares/cost
// basis and the value-history chart from Sharesies — provided you're
// currently connected (Connectors -> Sharesies). Silently skipped otherwise,
// so Refresh still works as a plain price recalc when disconnected.
// Returns what happened so callers can tell the user: 'updated', 'skipped'
// (aggregate view, or this portfolio was never linked to Sharesies),
// 'not-connected' (the server's in-memory Sharesies login is gone — it's lost
// whenever the server restarts), or 'failed'.
async function refreshSharesiesLink() {
  if (isAgg()) return 'skipped';
  // Captured up front: this whole function is a chain of awaited network
  // calls, and `state`/`activePid` are shared globals that selectPortfolio()
  // swaps out wholesale on tab switch. Without this guard, switching tabs
  // mid-refresh made the response land in whatever portfolio was open by
  // the time it resolved — merging one portfolio's Sharesies holdings into
  // a completely different one. Every await below re-checks that the user
  // hasn't navigated away before touching `state`.
  const targetPid = activePid;
  const stillHere = () => activePid === targetPid && !isAgg();
  const p = portfolios.find((x) => x.id === targetPid);
  if (!p?.sharesies_linked) return 'skipped';
  try {
    const st = await (await sharesiesFetch('/api/sharesies/status')).json();
    if (!st.connected) return 'not-connected';
    if (!stillHere()) return 'skipped';
    const pid = encodeURIComponent(p.sharesies_portfolio_id || '');
    const [holdRes, histRes] = await Promise.all([
      sharesiesFetch('/api/sharesies/holdings?portfolioId=' + pid),
      sharesiesFetch('/api/sharesies/history?portfolioId=' + pid),
    ]);
    const holdData = await holdRes.json();
    if (holdRes.ok && stillHere()) {
      for (const h of holdData.holdings || []) {
        const existing = state.positions.find((x) => x.ticker === h.ticker);
        // h.price is only set for cash-like holdings (Wallet/Save/KiwiSaver
        // — see getCashLikeHolding in sharesies.js), since nothing will ever
        // live-price them; real stock tickers get 0 and Finnhub/Yahoo fills
        // it in within seconds, same as any manually-added position.
        if (existing) { existing.shares = h.shares; existing.cost = h.cost; if (h.price != null) existing.price = h.price; }
        else state.positions.push({ id: Store.id(), ticker: h.ticker, shares: h.shares, cost: h.cost, price: h.price ?? 0, day: 0, category: '' });
      }
    }
    const histData = await histRes.json();
    if (histRes.ok && histData.history?.length && stillHere()) {
      await Store.saveSharesiesHistory(targetPid, histData.history);
      p.sharesies_history = histData.history;
      p.sharesies_synced_at = new Date().toISOString();
      return 'updated';
    }
    return 'failed';
  } catch (e) {
    console.warn('Sharesies refresh failed:', e);
    return 'failed';
  }
}

// Just the price pull — cheap, safe to poll frequently. Separate from
// refreshSharesiesLink (which re-fetches your whole Sharesies holdings +
// history and writes to Supabase) so the fast auto-poll below never gets
// stalled behind, or triggers, that heavier sync.
async function refreshPricesOnly() {
  const pill = $('#status-pill');
  if (!Prices.live) {
    render(); // manual mode: just recompute + timestamp
    return;
  }
  const targetPid = activePid; // see the staleness note in refreshSharesiesLink
  try {
    // Cash-like holdings (Wallet/Save/KiwiSaver) aren't tradeable market
    // symbols — asking Finnhub/Yahoo for them would just waste a lookup, so
    // their price stays whatever Sharesies last reported (see getCashLikeHolding).
    const quotes = await Prices.fetchQuotes(state.positions.filter((p) => !isCash(p)).map((p) => p.ticker));
    if (activePid !== targetPid) return; // switched tabs while the quotes were in flight
    for (const p of state.positions) {
      const q = quotes[p.ticker];
      if (q) {
        p.price = q.price;
        p.day = q.day;
      }
    }
    pill.classList.add('live');
    pill.innerHTML = '<span class="dot"></span>Live';
    if (!isAgg()) setLastPriceRefresh(activePid, Date.now());
    render();
  } catch (err) {
    console.warn(err);
  }
}
// Small pill toast for the manual Refresh button — shows while the refresh
// is in flight, then flips to a done state and fades out on its own.
let toastHideTimer;
function showToast(text, { spinner = false, done = false } = {}) {
  const el = $('#toast');
  if (!el) return;
  clearTimeout(toastHideTimer);
  el.innerHTML = (spinner ? '<span class="spinner"></span>' : '') + esc(text);
  el.classList.toggle('done', done);
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  if (done) {
    toastHideTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 200);
    }, 1800);
  }
}
// Holdings auto-refresh: requesting the symbols also keeps them in the
// Finnhub hot set server-side, so they're always freshly priced. Polling
// every 15s (rather than the old 60s) so the "Stock prices last refreshed"
// note tracks Finnhub's actual ~15-20s per-symbol cadence instead of lagging
// behind it — this only re-reads the server's cache, it doesn't consume any
// extra Finnhub budget (see /api/quotes in server.js). Deliberately does NOT
// call refreshSharesiesLink — that's a heavier sync, only worth doing when
// a portfolio is actually opened/imported, not on every 15s tick.
setInterval(() => {
  if (ready && state.positions.length) refreshPricesOnly();
}, 15000);

// ---- Auth + boot --------------------------------------------------------

function showLogin() {
  ready = false;
  currentUid = null;
  $('#login-screen').hidden = false;
  $('#app').hidden = true;
  $('#side-rail').hidden = true;
}

let currentUid = null;

let currentUser = null; // the Supabase auth user — each Google sign-in gets its own stable id/email here

// Every /api/sharesies/* call must prove which app account is asking — the
// Node server verifies this access token against Supabase itself
// (verifyUser in server.js) and uses the id *Supabase* returns, never a
// value the client could just claim, so two different Google-signed-in
// users of this app can never see each other's Sharesies connection or
// data, even a deliberately malicious client.
async function sharesiesFetch(url, opts = {}) {
  const { data } = await window.sb.auth.getSession();
  const token = data?.session?.access_token || '';
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(url, { ...opts, headers });
}

// Small avatar button in the topbar, left of the favourites star — same
// avatar_url/initials logic as ProfilePage.render, just a smaller target.
// Kept in sync by calling this wherever the avatar can change (sign-in,
// upload) rather than polling.
function renderTopbarAvatar() {
  const u = currentUser;
  if (!u) return;
  const meta = u.user_metadata || {};
  const name = meta.full_name || meta.name || (u.email || '').split('@')[0];
  const avatarUrl = meta.avatar_url || meta.picture || '';
  const img = $('#topbar-avatar-img');
  const fallback = $('#topbar-avatar-fallback');
  if (avatarUrl) {
    img.src = avatarUrl;
    img.hidden = false;
    fallback.hidden = true;
  } else {
    fallback.textContent = (name[0] || '?').toUpperCase();
    fallback.hidden = false;
    img.hidden = true;
  }
}
$('#topbar-avatar').addEventListener('click', () => { if (window.ProfilePage) ProfilePage.show(); });

async function showApp(user) {
  currentUser = user;
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  $('#side-rail').hidden = false;
  const email = user.email || '';
  $('#user-email').textContent = email;
  $('#user-chip').hidden = true; // email chip hidden — frees topbar space for the ticker
  renderTopbarAvatar();

  // Auth can fire more than once per sign-in (initial-session + signed-in);
  // only load once per user so concurrent boots don't race.
  if (currentUid === user.id) return;
  currentUid = user.id;

  // Open Home right away, before any of the async portfolio load below —
  // otherwise the summary paints first (visible for however long
  // Store.listPortfolios()/selectPortfolio() take) and Home only overlays on
  // top a moment later, a visible flash on every refresh. Showing it here
  // means body.home-open's CSS (hide everything but #home-page) applies
  // before the summary ever gets a chance to render, exactly like clicking
  // the rail's Home button while already on the summary.
  if (window.HomePage) HomePage.show();

  // A user's own pasted Finnhub key, if they've saved one (Connectors page)
  // — see Prices.finnhubKey's own comment for what this changes.
  try { Prices.finnhubKey = await Store.getFinnhubKey(); } catch { Prices.finnhubKey = ''; }

  // Restore locked Bull case projection(s), if any (see the lock button near
  // #bull-load) — the widget only surfaces one TICKER at a time, so the most
  // recently locked one wins if locks exist for more than one. Every locked
  // case (Bull/Standard/Bear) belonging to that same ticker gets restored
  // into its own tab; any case that wasn't locked just starts fresh.
  try {
    const locks = await Store.getBullLocks();
    const keys = Object.keys(locks);
    if (keys.length) {
      const last = locks[keys[keys.length - 1]];
      bullState = { ticker: last.ticker, name: last.name, price: last.price, shares: last.shares, actual: last.actual, netIncomeUnit: last.netIncomeUnit };
      const actualYear = parseInt(String(last.actual?.label || '').replace(/\D/g, ''), 10) || new Date().getFullYear();
      bullCases = { bull: bullEmptyCase(actualYear + 1), standard: bullEmptyCase(actualYear + 1), bear: bullEmptyCase(actualYear + 1) };
      for (const k of keys) {
        const snap = locks[k];
        if (snap.ticker !== last.ticker) continue;
        const cs = BULL_CASES.includes(snap.case) ? snap.case : 'bull';
        bullCases[cs] = { investment: snap.investment, years: snap.years, locked: true };
      }
      bullActiveCase = BULL_CASES.includes(last.case) ? last.case : 'bull';
      const label = $('#bull-loaded-label');
      if (label) label.textContent = bullState.name ? `${bullState.ticker} — ${bullState.name}` : bullState.ticker;
      renderBullTable();
    }
  } catch (e) { console.warn('Failed to restore locked Bull case projection:', e); }

  ready = false;
  try {
    portfolios = await Store.listPortfolios();
    if (!portfolios.length) {
      // First run: make a default portfolio and adopt any pre-existing rows
      // (from before portfolios existed). Seed sample data only if there's
      // nothing to adopt.
      const pid = Store.id();
      await Store.createPortfolio('My portfolio', pid);
      const adopted = await Store.adoptOrphans(pid);
      if (!adopted) await Store.save(pid, Store.seed());
      portfolios = [{ id: pid, name: 'My portfolio' }];
    }
    portfolios = applyPortfolioOrder(portfolios);
    // Default landing is the aggregated summary; otherwise honour the last pick.
    const lastPid = localStorage.getItem('cashmoney.activePid');
    const pid = lastPid === AGG || portfolios.some((p) => p.id === lastPid) ? lastPid : AGG;
    await selectPortfolio(pid, { closeOverlays: false }); // Home is already open (see above) — don't let this close it back to the summary
  } catch (e) {
    console.error('Load failed:', e);
    $('#updated').textContent = 'Could not load — check the table setup.';
  }
}

// ---- Portfolio dropdown -------------------------------------------------

// closeOverlays: false is the boot-time case only (see showApp) — Home is
// already open there on purpose, and this call is just loading the summary's
// data in the background underneath it, not the user actually navigating to
// a portfolio tab. Every real navigation (tab click, etc.) keeps the default
// true, same as before.
async function selectPortfolio(pid, { closeOverlays = true } = {}) {
  // Leave any overlay page (stock, connectors, home, profile) — switching
  // portfolio means the user wants to see that portfolio.
  if (closeOverlays) {
    if (window.StockPage) StockPage.close();
    if (window.ConnectorsPage) ConnectorsPage.close();
    if (window.HomePage) HomePage.close();
    if (window.ProfilePage) ProfilePage.close();
    if (window.ResearchPage) ResearchPage.close();
    if (window.EarningsCalendarPage) EarningsCalendarPage.close();
    if (window.CompoundPage) CompoundPage.close();
    if (window.SettingsPage) SettingsPage.close();
  }
  activePid = pid;
  localStorage.setItem('cashmoney.activePid', pid);
  Nav.push({ type: 'portfolio', pid });
  const agg = pid === AGG;
  renderPortfolioTabs();
  setAggregateMode(agg);
  ready = false;
  try {
    if (agg) {
      aggRows = await Store.loadAll(); // every portfolio's rows, cached
      applyLinkedFilter(); // narrow to the linked (ticked) portfolios
      await loadSummaryChartData();
    } else {
      state = await Store.load(pid);
    }
    ready = true;
    render();
    if (agg) recordSummarySnapshot(); // fire-and-forget: today's point, throttled
  } catch (e) {
    console.error('Portfolio load failed:', e);
    $('#updated').textContent = 'Could not load portfolio.';
  }
}

// ---- Summary: linked portfolios ----------------------------------------
// The summary sums only the portfolios the user has "linked" (ticked). We load
// every row once (aggRows) and filter to the linked set, so ticking/unticking
// re-sums instantly without refetching.
let aggRows = { positions: [], notes: [] };
const LINKED_KEY = 'cashmoney.linkedPids';

// The set of linked portfolio ids. Default (nothing saved yet) = all of them,
// so the summary behaves as before until the user customises it. Ids of deleted
// portfolios are ignored.
function getLinkedSet() {
  const valid = portfolios.map((p) => p.id);
  const saved = localStorage.getItem(LINKED_KEY);
  if (saved === null) return new Set(valid);
  try {
    return new Set(JSON.parse(saved).filter((id) => valid.includes(id)));
  } catch {
    return new Set(valid);
  }
}

function applyLinkedFilter() {
  const linked = getLinkedSet();
  state = {
    positions: aggRows.positions.filter((p) => linked.has(p.portfolio_id)),
    notes: aggRows.notes.filter((n) => linked.has(n.portfolio_id)),
  };
}

function renderLinkedMenu() {
  const linked = getLinkedSet();
  $('#linked-menu').innerHTML = portfolios
    .map(
      (p) => `<label class="linked-item">
        <input type="checkbox" data-link="${p.id}"${linked.has(p.id) ? ' checked' : ''} />
        <span>${esc(p.name)}</span>
      </label>`
    )
    .join('') || '<div class="linked-empty">No portfolios yet.</div>';
}

const linkedMenu = $('#linked-menu');
$('#linked-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  linkedMenu.hidden = !linkedMenu.hidden;
  if (!linkedMenu.hidden) renderLinkedMenu();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.linked-dd')) linkedMenu.hidden = true;
});
linkedMenu.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-link]');
  if (!cb) return;
  const set = getLinkedSet();
  if (cb.checked) set.add(cb.dataset.link);
  else set.delete(cb.dataset.link);
  localStorage.setItem(LINKED_KEY, JSON.stringify([...set]));
  applyLinkedFilter();
  render(); // re-sum metrics/holdings/allocation/notes from the new linked set
});

// The aggregated summary is read-only: it merges holdings from the linked
// portfolios, so there's no single portfolio to add to or save back into. Turn
// the editing controls off (CSS hides per-row actions via the body class), and
// swap the Holdings title for the "Linked portfolios" picker.
function setAggregateMode(on) {
  document.body.classList.toggle('aggregate', on);
  $('#add-btn').disabled = on;
  $('#import-btn').hidden = on; // import applies to a specific portfolio, not the summary
  $('#add-note-btn').hidden = on;
  $('#holdings-title').hidden = on;
  $('#linked-dd').hidden = !on;
  $('#pf-market-block').hidden = on; // read-only summary: hide the portfolio search
  if (on) renderLinkedMenu();
  else linkedMenu.hidden = true;
}

// The portfolios render as Chrome-style tabs under the summary title: one tab
// per portfolio (click to open, double-click to rename, × to delete) plus a
// trailing "+" tab to create a new one. The active tab is the one being viewed;
// none are active while the aggregated summary is showing.
function renderPortfolioTabs() {
  const canDelete = portfolios.length > 1;
  const colors = getTabColors();
  const tabs = portfolios
    .map((p) => {
      const active = !isAgg() && p.id === activePid;
      const color = colors[p.id];
      return `<div class="pf-tab${active ? ' active' : ''}" data-pid="${p.id}" draggable="true" title="${esc(p.name)}"${color ? ` style="border-top:3px solid ${esc(color)}"` : ''}>
        <span class="pf-tab-name">${esc(p.name)}</span>
        ${canDelete ? `<button class="pf-tab-x" data-del-pf="${p.id}" title="Delete" aria-label="Delete ${esc(p.name)}">×</button>` : ''}
      </div>`;
    })
    .join('');
  $('#portfolio-tabs').innerHTML = tabs + '<button class="pf-tab pf-tab-new" data-new="1" title="New portfolio" aria-label="New portfolio">+</button>';
  $('#summary-btn').classList.toggle('active', isAgg());
}

// The brand logo and the "Portfolio's summary" title both go Home —
// the aggregated summary across every portfolio.
// "Portfolio's summary" -> the aggregated view across every portfolio.
const goHome = () => {
  if (!isAgg()) selectPortfolio(AGG);
  else {
    // Already on the summary: just leave whatever overlay page is open.
    if (window.StockPage) StockPage.close();
    if (window.ConnectorsPage) ConnectorsPage.close();
    if (window.ProfilePage) ProfilePage.close();
    if (window.HomePage) HomePage.close();
    if (window.ResearchPage) ResearchPage.close();
    if (window.EarningsCalendarPage) EarningsCalendarPage.close();
    if (window.CompoundPage) CompoundPage.close();
    if (window.SettingsPage) SettingsPage.close();
  }
};
$('#summary-btn').addEventListener('click', goHome);

// Permanent back button beside the tabs — history.back() (not a direct
// close()/selectPortfolio call) so it always goes to whatever view was
// actually last shown, same mechanism as the stock page's own "← Back"
// (see Nav/applyView above and the popstate listener that drives them both).
$('#pf-back-btn').addEventListener('click', () => history.back());

// The logo and the rail "Home" button open the market Home page (no portfolio).
const openHome = () => { if (window.HomePage) HomePage.show(); };
$('#home-btn').addEventListener('click', openHome);

// Left rail.
$('#rail-home').addEventListener('click', openHome);
$('#rail-profile').addEventListener('click', () => ProfilePage.show());
let lastCoverageData = null; // last /api/quotes payload, so dragging a coverage row can re-render instantly without a network round trip
const ConnectorsPage = {
  show() {
    Nav.push({ type: 'connectors' });
    if (window.StockPage) StockPage.close(); // one page at a time
    if (window.HomePage) HomePage.close();
    if (window.ResearchPage) ResearchPage.close();
    if (window.EarningsCalendarPage) EarningsCalendarPage.close();
    if (window.CompoundPage) CompoundPage.close();
    if (window.SettingsPage) SettingsPage.close();
    document.body.classList.add('connectors-open');
    $('#connectors-page').hidden = false;
    window.scrollTo(0, 0);
    this.refreshStatus();
    this.editingKey = false;
    this.refreshKeyForm();
    // In case a coverage order was saved locally before the server-side
    // sweep priority existed (or the server was restarted and lost it) —
    // harmless to resend, setPriorityOrder just overwrites.
    try {
      const saved = JSON.parse(localStorage.getItem(COVERAGE_ORDER_KEY)) || [];
      if (saved.length) fetch('/api/coverage-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: saved }) }).catch(() => {});
    } catch {}
  },
  // Reflects whether *this* user already has a personal key saved — the
  // input stays blank either way (never re-displays a saved key in plain
  // text), just the status line below it changes. Once a key is saved, the
  // input locks (disabled, not typeable) until "Change API key" is clicked —
  // stops an accidental keystroke silently overwriting a working key.
  refreshKeyForm() {
    const status = $('#finnhub-key-status');
    const input = $('#finnhub-key-input');
    const hasKey = !!Prices.finnhubKey;
    const editing = this.editingKey || !hasKey;
    input.disabled = !editing;
    input.value = '';
    input.placeholder = hasKey && !editing ? 'API key saved — click Change to edit' : 'Paste your Finnhub API key';
    $('#finnhub-key-save').hidden = !editing;
    $('#finnhub-key-change').hidden = !hasKey || editing;
    if (hasKey) {
      status.textContent = 'Your own key is active — holdings refresh on your own budget.';
      status.classList.add('on');
    } else {
      status.textContent = 'Using the app\'s shared key.';
      status.classList.remove('on');
    }
  },
  // Finnhub status comes from /api/quotes: `enabled` = key configured on the
  // server, `count` = symbols currently priced in the cache.
  async refreshStatus() {
    const el = $('#finnhub-status');
    try {
      const r = await fetch('/api/quotes');
      const d = await r.json();
      const meta = $('#finnhub-meta');
      const key = String(d.key || '').replace(/[&<>"']/g, '');
      const hot = d.hot || [];
      $('#conn-total-priced').textContent = Number(d.count || 0).toLocaleString();
      $('#conn-total-financials').textContent = Number((d.yahooFinancials || {}).diskCached || 0).toLocaleString();
      // Count priced symbols by source (the server cache mixes both). Last
      // refresh = newest finnhub-sourced timestamp.
      let last = 0;
      let fhCount = 0;
      for (const s in d.quotes || {}) {
        if (d.quotes[s].source === 'yahoo') continue;
        fhCount++;
        if (d.quotes[s].ts > last) last = d.quotes[s].ts;
      }
      const when = last ? new Date(last).toLocaleTimeString() : '—';
      // Stale if the newest Finnhub quote is older than 2 min — the free tier is
      // throttling/erroring, so the hot set has stopped refreshing.
      const ageMs = last ? Date.now() - last : Infinity;
      const stale = last && ageMs > 120000;
      // `d.enabled` is only the shared server-wide key (server/.env's
      // FINNHUB_KEY) — a signed-in user's own personal key (pasted below)
      // prices their holdings independently of that, so the pill shouldn't
      // flatly say "No API key" while this user's own key is active. See the
      // same fix applied to the Market/Search list's status line.
      const ownKeyActive = !!Prices.finnhubKey;
      if (d.enabled) {
        if (stale) {
          const mins = Math.floor(ageMs / 60000);
          el.className = 'connector-status stale';
          el.innerHTML = `<span class="dot"></span>Stale · no refresh for ${mins}m (throttled?)`;
        } else {
          el.className = 'connector-status on';
          el.innerHTML = `<span class="dot"></span>Connected · ${Number(fhCount).toLocaleString()} priced`;
        }
        meta.innerHTML = `Last refresh ${when} · API key <code>${key}</code>`;
      } else if (ownKeyActive) {
        el.className = 'connector-status on';
        el.innerHTML = '<span class="dot"></span>Active via your personal key';
        meta.innerHTML = `Last refresh ${when} · shared server key not set — priced on your own budget`;
      } else {
        el.className = 'connector-status off';
        el.innerHTML = '<span class="dot"></span>No API key — set FINNHUB_KEY in server/.env';
        meta.textContent = '';
      }
      const row = (k, v) => `<span class="conn-k">${k}</span><span class="conn-v">${v}</span>`;
      $('#finnhub-detail').innerHTML = '<div class="conn-grid">' + [
        row('Role', 'Premium lane — prices the hot set (portfolio holdings, ticker strip, favourites) on a stable budget'),
        row('Status', d.enabled ? 'Connected' : ownKeyActive ? 'Active via your personal key' : 'No API key'),
        row('API key', key ? `<code>${key}</code>` : ownKeyActive ? 'Your own key (not shown)' : '—'),
        row('Rate budget', '60 calls/min (free tier) · 1 call/sec'),
        row('Hot set', `${hot.length} symbols — each refreshes every ~${Math.max(hot.length, 1)}s`),
        row('Hot symbols', hot.length ? hot.join(', ') : '—'),
        row('Last refresh', when),
        row('Your personal key', ownKeyActive ? 'Active — pricing your holdings on your own budget' : 'Not set — see below to add one'),
        row('Personal keys active', `${Number(d.personalKeys || 0).toLocaleString()} user(s) (including you, if set above) with their own key`),
        row('Also provides', 'Company profiles, market cap, PE/EPS/beta, 52-week ranges, the searchable symbol universe'),
        row('Endpoints', '<code>/quote</code> <code>/stock/profile2</code> <code>/stock/metric</code> <code>/stock/symbol</code>'),
        row('Config', '<code>FINNHUB_KEY</code> in server/.env'),
      ].join('') + '</div>';

      const yEl = $('#yahoo-status');
      const y = d.yahoo;
      if (y && y.enabled) {
        yEl.className = 'connector-status on';
        yEl.innerHTML = `<span class="dot"></span>Active · ${Number(y.ok || 0).toLocaleString()} fetched` + (y.lastTs ? ` · last ${new Date(y.lastTs).toLocaleTimeString()}` : '');
      } else {
        yEl.className = 'connector-status';
        yEl.innerHTML = '<span class="dot"></span>Not running';
      }
      $('#yahoo-detail').innerHTML = '<div class="conn-grid">' + [
        row('Role', 'Default lane — background sweep pricing every stock outside the Finnhub hot set'),
        row('Status', y && y.enabled ? 'Active' : 'Not running (restart the server)'),
        row('Auth', 'None — public endpoint, no API key'),
        row('Sweep size', y ? `${Number(y.universe || 0).toLocaleString()} symbols (cap: YAHOO_SWEEP_CAP, index members first)` : '—'),
        row('Rate', '~2.5 requests/sec · full sweep ≈ 33 min · 15s back-off on errors'),
        row('Fetched OK', y ? Number(y.ok || 0).toLocaleString() : '—'),
        row('Failures', y ? Number(y.fail || 0).toLocaleString() + (y.lastErr ? ` — last: ${String(y.lastErr).replace(/[&<>"']/g, '')}` : '') : '—'),
        row('Last fetch', y && y.lastTs ? new Date(y.lastTs).toLocaleTimeString() : '—'),
        row('Indices covered', 'S&P 500, Nasdaq 100, Dow 30, Russell 2000, FTSE 100 (.L), DAX (.DE), Nikkei 225 (.T)'),
        row('Note', 'International quotes are in local currency (pence, EUR, JPY). Unofficial endpoint — brief 429 blocks possible; the loop recovers on its own'),
        row('Endpoint', '<code>query1.finance.yahoo.com/v8/finance/chart</code>'),
      ].join('') + '</div>';

      const yfEl = $('#yahoo-financials-status');
      const yf = d.yahooFinancials;
      if (yf && (yf.hasCrumb || yf.diskCached > 0)) {
        yfEl.className = 'connector-status on';
        yfEl.innerHTML = `<span class="dot"></span>Connected · ${Number(yf.diskCached || 0).toLocaleString()} on disk` + (yf.lastTs ? ` · last ${new Date(yf.lastTs).toLocaleTimeString()}` : '');
      } else if (yf && yf.fail > 0) {
        yfEl.className = 'connector-status off';
        yfEl.innerHTML = '<span class="dot"></span>Crumb fetch failing';
      } else {
        yfEl.className = 'connector-status';
        yfEl.innerHTML = '<span class="dot"></span>Not fetched yet — open a stock\'s Financials tab';
      }
      $('#yahoo-financials-detail').innerHTML = '<div class="conn-grid">' + [
        row('Role', 'Income statement, balance sheet, cash flow (annual + quarterly) for the stock page\'s Financials tab'),
        row('Status', yf && yf.hasCrumb ? 'Connected' : 'No session yet'),
        row('Auth', 'Session cookie + "crumb" anti-scraping token, fetched on first use and reused'),
        row('Cache', yf ? `${Number(yf.diskCached || 0).toLocaleString()} symbols on disk (data/financials/), ${Number(yf.cached || 0).toLocaleString()} hot in memory · 24h per symbol (statements don\'t change intraday) · survives restarts` : '—'),
        row('Fetched OK', yf ? Number(yf.ok || 0).toLocaleString() : '—'),
        row('Failures', yf ? Number(yf.fail || 0).toLocaleString() + (yf.lastErr ? ` — last: ${String(yf.lastErr).replace(/[&<>"']/g, '')}` : '') : '—'),
        row('Last fetch', yf && yf.lastTs ? new Date(yf.lastTs).toLocaleTimeString() : '—'),
        row('Note', 'A separate connector from the quote scraper above — different auth model, only fetched on demand when a Financials tab is opened, not swept continuously'),
        row('Endpoint', '<code>query2.finance.yahoo.com/ws/fundamentals-timeseries</code>'),
      ].join('') + '</div>';

      await refreshSharesiesStatus();
      lastCoverageData = d;
      renderCoverage(d);
    } catch {
      el.className = 'connector-status off';
      el.innerHTML = '<span class="dot"></span>Server unreachable';
      $('#finnhub-meta').textContent = '';
    }
  },
  close() {
    document.body.classList.remove('connectors-open');
    $('#connectors-page').hidden = true;
  },
};
window.ConnectorsPage = ConnectorsPage;
$('#rail-connectors').addEventListener('click', () => ConnectorsPage.show());
$('#finnhub-key-save').addEventListener('click', async () => {
  const input = $('#finnhub-key-input');
  const key = input.value.trim();
  if (!key) return;
  try {
    await Store.saveFinnhubKey(key);
    Prices.finnhubKey = key;
    ConnectorsPage.editingKey = false;
    ConnectorsPage.refreshKeyForm();
    if (state.positions.length) refreshPricesOnly(); // registers it with the server right away
    showToast('Finnhub key saved', { done: true });
  } catch (e) {
    $('#finnhub-key-status').textContent = 'Could not save: ' + (e.message || e);
  }
});
$('#finnhub-key-change').addEventListener('click', () => {
  ConnectorsPage.editingKey = true;
  ConnectorsPage.refreshKeyForm();
  $('#finnhub-key-input').focus();
});
$('#finnhub-key-clear').addEventListener('click', async () => {
  try {
    await Store.saveFinnhubKey('');
    Prices.finnhubKey = '';
    ConnectorsPage.editingKey = false;
    ConnectorsPage.refreshKeyForm();
    if (state.positions.length) refreshPricesOnly(); // tells the server to drop this user's loop
    showToast('Finnhub key cleared', { done: true });
  } catch (e) {
    $('#finnhub-key-status').textContent = 'Could not clear: ' + (e.message || e);
  }
});

// "Stocks to research" — a personal watchlist of tickers, independent of any
// portfolio (like Favourites, but its own list/purpose). Local only, same
// tier as the other display-preference lists in this file (no Supabase
// column) — this is a scratchpad, not a real holding.
const RESEARCH_LIST_KEY = 'cashmoney.researchList';
function getResearchList() {
  try { return JSON.parse(localStorage.getItem(RESEARCH_LIST_KEY)) || []; } catch { return []; }
}
function saveResearchList(list) {
  localStorage.setItem(RESEARCH_LIST_KEY, JSON.stringify(list));
}
// Clicking + swaps in a search box (same ranked Market.search() the topbar
// search dropdown uses) instead of a plain prompt(), so matches show up as
// you type and you just click one.
let rwAdding = false;
let rwSearchTimer;
function renderResearchWatchlist() {
  const wrap = $('#research-watchlist');
  const list = getResearchList();
  const items = list
    .map(
      (sym) => `<div class="rw-item" data-sym="${esc(sym)}">
        <button class="rw-x" data-rw-del="${esc(sym)}" title="Remove" aria-label="Remove ${esc(sym)}">×</button>
        ${esc(sym)}
      </div>`
    )
    .join('');
  const addUi = rwAdding
    ? `<div class="rw-search-wrap">
        <input class="rw-search" id="rw-search" placeholder="Search stocks…" autocomplete="off" />
        <div class="rw-search-menu" id="rw-search-menu" hidden></div>
      </div>`
    : `<button class="rw-add" id="rw-add" title="Add a stock to research" aria-label="Add a stock to research">+</button>`;
  wrap.innerHTML = items + addUi;
  if (rwAdding) {
    const input = $('#rw-search');
    input.focus();
    input.addEventListener('input', () => {
      clearTimeout(rwSearchTimer);
      rwSearchTimer = setTimeout(() => renderRwSearchResults(input.value.trim()), 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { rwAdding = false; renderResearchWatchlist(); }
    });
  }
}
function renderRwSearchResults(text) {
  const menu = $('#rw-search-menu');
  if (!menu) return;
  if (!text || !window.Market) { menu.hidden = true; return; }
  const rows = Market.search(text);
  if (!rows.length) {
    menu.innerHTML = '<div class="ts-empty">No matches.</div>';
    menu.hidden = false;
    return;
  }
  menu.innerHTML = rows
    .map((x) => `<button class="ts-item" data-sym="${esc(x.s)}"><span class="ts-sym">${esc(x.s)}</span><span class="ts-name">${esc(x.n || '')}</span></button>`)
    .join('');
  menu.hidden = false;
}
function addToResearchList(sym) {
  const list = getResearchList();
  if (!list.includes(sym)) { list.push(sym); saveResearchList(list); }
  rwAdding = false;
  renderResearchWatchlist();
}
$('#research-watchlist').addEventListener('click', (e) => {
  const del = e.target.closest('[data-rw-del]');
  if (del) {
    saveResearchList(getResearchList().filter((s) => s !== del.dataset.rwDel));
    renderResearchWatchlist();
    return;
  }
  if (e.target.closest('#rw-add')) {
    rwAdding = true;
    renderResearchWatchlist();
    return;
  }
  const result = e.target.closest('.ts-item[data-sym]');
  if (result) {
    addToResearchList(result.dataset.sym);
    return;
  }
  const item = e.target.closest('.rw-item[data-sym]');
  if (item && window.StockPage) StockPage.show(item.dataset.sym, { tab: 'research' });
});
// Cancel the search box if you click elsewhere on the page (same pattern as
// the topbar search dropdown).
document.addEventListener('click', (e) => {
  if (rwAdding && !e.target.closest('.rw-search-wrap') && !e.target.closest('#rw-add')) {
    rwAdding = false;
    renderResearchWatchlist();
  }
});

// Research page: every portfolio's research notes in one list. Notes are
// portfolio-scoped (state.notes only ever holds the currently-open
// portfolio's), so this pulls the same all-portfolios read Store.loadAll()
// already uses for the aggregate summary, but keeps only the notes here.
const ResearchPage = {
  async show() {
    Nav.push({ type: 'research' });
    if (window.StockPage) StockPage.close();
    if (window.ConnectorsPage) ConnectorsPage.close();
    if (window.HomePage) HomePage.close();
    if (window.ProfilePage) ProfilePage.close();
    if (window.CompoundPage) CompoundPage.close();
    if (window.SettingsPage) SettingsPage.close();
    document.body.classList.add('research-open');
    $('#research-page').hidden = false;
    window.scrollTo(0, 0);
    renderResearchWatchlist();
    if (window.BullWidget) BullWidget.returnHome(); // may have been moved onto a stock page's Research tab
    renderBullTable();
    await this.render();
  },
  async render() {
    const wrap = $('#research-notes');
    wrap.innerHTML = '<span class="notes-empty">Loading…</span>';
    let notes = [];
    try {
      notes = (await Store.loadAll()).notes || [];
    } catch (e) {
      wrap.innerHTML = '<span class="notes-empty">Could not load notes.</span>';
      return;
    }
    if (!notes.length) {
      wrap.innerHTML = '<span class="notes-empty">No research notes yet — add one from any portfolio\'s Research notes card.</span>';
      return;
    }
    const nameOf = (pid) => portfolios.find((p) => p.id === pid)?.name || 'Unknown portfolio';
    wrap.innerHTML = notes
      .map(
        (n) => `<div class="note" data-note="${n.id}" data-pid="${n.portfolio_id}">
          <p class="n-source">${esc(nameOf(n.portfolio_id))}</p>
          <p class="n-title">${esc(n.title)}</p>
          <p class="n-body">${esc(n.body || '')}</p>
        </div>`
      )
      .join('');
  },
  close() {
    document.body.classList.remove('research-open');
    $('#research-page').hidden = true;
  },
};
window.ResearchPage = ResearchPage;
$('#rail-research').addEventListener('click', () => ResearchPage.show());
// Earnings Calendar page lives in its own file (earnings-calendar.js) — see
// window.EarningsCalendarPage there.
$('#rail-earnings').addEventListener('click', () => { if (window.EarningsCalendarPage) EarningsCalendarPage.show(); });

// ---- Research page: Bull case calculator ---------------------------------
// A freeform valuation projection, not tied to any portfolio holding or
// saved anywhere. Loading a ticker fills in a separate, read-only "actual"
// column (real revenue/net income/EPS from the latest reported fiscal year
// — same financials the stock page's Financials tab uses) to the left of
// the projection years; every projection year's growth %, margin %, and P/E
// estimates are typed in by hand and drive the rest of the row live,
// chaining off the actual column first, then each other.
const BULL_YEARS = 5;
function bullEmptyYears(startYear) {
  return Array.from({ length: BULL_YEARS }, (_, i) => ({
    label: String(startYear + i),
    growthPct: null,
    marginPct: null,
    netIncomeRaw: null, // last dollar amount typed directly into Net income, if any — see bullCompute's staleness check
    peLow: null,
    peHigh: null,
  }));
}
// Three independent scenarios (Bull/Standard/Bear) for the same loaded
// stock — same real "actual" column (shared, since it's just reported data),
// but each case gets its own growth/margin/P/E/investment inputs and its own
// lock, so switching tabs never mixes one case's assumptions into another's.
const BULL_CASES = ['bull', 'standard', 'bear'];
const BULL_CASE_LABELS = { bull: 'Bull case', standard: 'Standard case', bear: 'Bear case' };
function bullEmptyCase(startYear) {
  return {
    investment: null, // a dollar amount typed into "Monetary input" — projected forward at each year's CAGR low/high
    years: bullEmptyYears(startYear),
    locked: false, // see BullWidget's lock button — true means this snapshot is saved server-side and read-only until unlocked
  };
}
let bullState = {
  ticker: '', name: '', price: null, shares: null, netIncomeUnit: { scale: 1e6, suffix: 'M' },
  actual: { label: 'Actual', revenue: null, netIncome: null, marginPct: null }, // latest reported fiscal year
};
let bullActiveCase = 'bull';
let bullCases = { bull: bullEmptyCase(new Date().getFullYear() + 1), standard: bullEmptyCase(new Date().getFullYear() + 1), bear: bullEmptyCase(new Date().getFullYear() + 1) };
function currentCase() { return bullCases[bullActiveCase]; }
// Net income runs into the hundreds of millions/billions — typing "63.84"
// instead of "63840000" needs a unit, picked once from the actual column's
// real magnitude so every year in the table reads on the same scale.
function bullUnitScale(n) {
  const abs = Math.abs(n || 0);
  if (abs >= 1e9) return { scale: 1e9, suffix: 'B' };
  if (abs >= 1e6) return { scale: 1e6, suffix: 'M' };
  if (abs >= 1e3) return { scale: 1e3, suffix: 'K' };
  return { scale: 1, suffix: '' };
}

function fmtBullMoney(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(1) + 'K';
  return sign + '$' + abs.toFixed(2);
}
function fmtBullPrice(n) { return n == null || Number.isNaN(n) ? '—' : '$' + n.toFixed(2); }
function fmtBullPct(n) { return n == null || Number.isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }

async function bullLoadTicker(ticker) {
  const sym = ticker.trim().toUpperCase();
  if (!sym) return;
  const label = $('#bull-loaded-label');
  label.textContent = 'Loading…';
  try {
    const [stockRes, finRes] = await Promise.all([
      fetch('/api/stock/' + encodeURIComponent(sym)),
      fetch('/api/financials/' + encodeURIComponent(sym)),
    ]);
    const stockData = await stockRes.json();
    const finData = await finRes.json();
    const income = finData?.financials?.income?.annual;
    const rows = income?.rows || [];
    // Walk backward from the newest date so a row with a gap in its most
    // recent period (e.g. this metric not yet reported) still finds the
    // latest period that actually has it, alongside that period's own date.
    const lastOf = (key) => {
      const row = rows.find((r) => r.key === key);
      if (!row) return { value: null, dateIdx: -1 };
      for (let i = row.values.length - 1; i >= 0; i--) if (row.values[i] != null) return { value: row.values[i], dateIdx: i };
      return { value: null, dateIdx: -1 };
    };
    const rev = lastOf('TotalRevenue');
    const ni = lastOf('NetIncomeCommonStockholders');
    const shares = lastOf('DilutedAverageShares').value;
    const price = stockData?.quote?.price ?? null;
    const actualDate = income?.dates?.[rev.dateIdx];
    const actualYear = actualDate ? new Date(actualDate).getUTCFullYear() : new Date().getFullYear();
    // The prior year's revenue is already in the same row we just read —
    // real YoY growth, not an assumption, so it's shown but not editable.
    const revRow = rows.find((r) => r.key === 'TotalRevenue');
    const prevRevenue = revRow && rev.dateIdx > 0 ? revRow.values[rev.dateIdx - 1] : null;
    const actual = {
      label: 'FY' + actualYear,
      revenue: rev.value,
      netIncome: ni.value,
      marginPct: rev.value && ni.value != null ? (ni.value / rev.value) * 100 : null,
      growthPct: rev.value != null && prevRevenue ? ((rev.value - prevRevenue) / prevRevenue) * 100 : null,
    };
    const carriedInvestment = currentCase().investment; // carried over — comparing the same $ amount across stocks (and cases) is the point
    bullState = { ticker: sym, name: stockData?.profile?.name || '', price, shares, actual, netIncomeUnit: bullUnitScale(actual.netIncome) };
    // Loading a (different) ticker always starts every case fresh and unlocked.
    bullCases = { bull: bullEmptyCase(actualYear + 1), standard: bullEmptyCase(actualYear + 1), bear: bullEmptyCase(actualYear + 1) };
    for (const c of BULL_CASES) bullCases[c].investment = carriedInvestment;
    label.textContent = bullState.name ? `${bullState.ticker} — ${bullState.name}` : bullState.ticker;
  } catch {
    label.textContent = 'Could not load ' + sym;
  }
  renderBullTable();
}

// First column is the real, latest-reported "actual" year (read-only) —
// every projection year chains off it: revenue off the prior (computed)
// year via growthPct; margin blank on a later year just carries the
// previous column's margin forward, so you only have to type a new one when
// your assumption actually changes.
function bullCompute() {
  const c = currentCase();
  const actualEps = bullState.actual.netIncome != null && bullState.shares ? bullState.actual.netIncome / bullState.shares : null;
  const out = [{
    label: bullState.actual.label, isActual: true, growthPct: bullState.actual.growthPct,
    revenue: bullState.actual.revenue, marginPct: bullState.actual.marginPct, netIncome: bullState.actual.netIncome,
    eps: actualEps, peLow: null, peHigh: null, priceLow: null, priceHigh: null, cagrLow: null, cagrHigh: null,
    investLow: c.investment, investHigh: c.investment, // day-0 baseline — no low/high split yet
  }];
  let prevRevenue = bullState.actual.revenue;
  c.years.forEach((y, i) => {
    const revenue = prevRevenue != null && y.growthPct != null ? prevRevenue * (1 + y.growthPct / 100) : null;
    const marginPct = y.marginPct != null ? y.marginPct : out[out.length - 1].marginPct;
    const netIncome = revenue != null && marginPct != null ? revenue * (marginPct / 100) : null;
    const eps = netIncome != null && bullState.shares ? netIncome / bullState.shares : null;
    const priceLow = eps != null && y.peLow != null ? eps * y.peLow : null;
    const priceHigh = eps != null && y.peHigh != null ? eps * y.peHigh : null;
    const yearsOut = i + 1; // years past the actual column, for annualizing CAGR
    const cagrLow = priceLow != null && bullState.price ? (Math.pow(priceLow / bullState.price, 1 / yearsOut) - 1) * 100 : null;
    const cagrHigh = priceHigh != null && bullState.price ? (Math.pow(priceHigh / bullState.price, 1 / yearsOut) - 1) * 100 : null;
    // Same growth ratio the stock's own low/high projection implies, applied
    // straight to whatever you'd have put in today — no need to round-trip
    // through the annualized CAGR figure above.
    const investLow = c.investment != null && priceLow != null && bullState.price ? c.investment * (priceLow / bullState.price) : null;
    const investHigh = c.investment != null && priceHigh != null && bullState.price ? c.investment * (priceHigh / bullState.price) : null;
    out.push({ label: y.label, isActual: false, growthPct: y.growthPct, revenue, marginPct, netIncome, eps, peLow: y.peLow, peHigh: y.peHigh, priceLow, priceHigh, cagrLow, cagrHigh, investLow, investHigh });
    prevRevenue = revenue;
  });
  return out;
}

function bullInputCell(field, idx, value, step, placeholder = 'ENTER VALUES') {
  return `<input type="text" inputmode="decimal" class="bull-input" data-field="${field}" data-idx="${idx}" value="${value ?? ''}" placeholder="${esc(String(placeholder))}" step="${step}"${currentCase().locked ? ' disabled' : ''} />`;
}
// Net income is editable too, in the same unit as the rest of the table
// (M/B — see bullUnitScale). Typing here sets an implied margin % (so
// Revenue -> Margin -> Net income keeps working automatically the other
// way), so the raw typed number only stays valid while it still matches
// what that margin currently computes to — if an earlier field (growth,
// margin) has since moved, this cell falls back to showing the live
// computed figure as a placeholder instead of a now-stale bold value.
function bullNetIncomeInputHtml(idx, computedNetIncome) {
  const unit = bullState.netIncomeUnit;
  const raw = currentCase().years[idx].netIncomeRaw;
  const fresh = raw != null && computedNetIncome != null && Math.abs(raw - computedNetIncome) / Math.max(Math.abs(raw), 1) < 0.001;
  const value = fresh ? Number((raw / unit.scale).toFixed(2)) : null;
  const placeholder = computedNetIncome != null ? (computedNetIncome / unit.scale).toFixed(2) + unit.suffix : 'ENTER VALUES';
  return `<span class="rev-input-wrap">${bullInputCell('netIncome', idx, value, 0.1, placeholder)}<span class="rev-input-unit bull-input-unit">${unit.suffix}</span></span>`;
}
// A single dollar amount, not per-year like every other input — how much
// you'd put in today, projected forward at each year's implied low/high
// growth (see "Investment value low/high" below). Lives only in the actual
// column since it's a one-time entry, not an assumption that changes yearly.
function bullInvestmentInputHtml() {
  return `<input type="text" inputmode="decimal" class="bull-input" data-field="investment" value="${currentCase().investment ?? ''}" placeholder="ENTER VALUES" step="100"${currentCase().locked ? ' disabled' : ''} />`;
}
// Computed (non-input) cells carry a data-cell marker so an input event can
// patch just their textContent — full re-render would recreate every input
// element too, which drops focus/caret position mid-keystroke.
function bullComputedCell(key, idx, text, extraCls = '') {
  return `<td class="num${extraCls ? ' ' + extraCls : ''}" data-cell="${key}" data-idx="${idx}">${text}</td>`;
}
// Bull/Standard/Bear tab bar — sits where the single static "Bull case" tag
// used to be. Switching tabs just repoints currentCase() at a different
// entry in bullCases and re-renders; nothing about one case's inputs ever
// touches another's.
function renderBullCaseTabs() {
  const wrap = $('#bull-case-tabs');
  if (!wrap) return;
  wrap.innerHTML = BULL_CASES
    .map((c) => `<button class="bull-case-tab bull-case-tab-${c}${c === bullActiveCase ? ' active' : ''}" data-case="${c}">${esc(BULL_CASE_LABELS[c])}</button>`)
    .join('');
}
function renderBullTable() {
  renderBullCaseTabs();
  const rows = bullCompute();
  // rows[0] is the read-only actual column; rows[i] for i>0 maps to
  // currentCase().years[i-1] for editable-input cells.
  const headTitle = bullState.ticker ? `${esc(bullState.ticker)}${bullState.price ? ' — ' + fmtBullPrice(bullState.price) : ''}` : 'Year';
  const headCells = rows.map((r) => `<th class="num">${esc(r.label)}</th>`).join('');
  const row = (label, cells, cls = '') => `<tr class="${cls}"><td>${label}</td>${cells}</tr>`;
  $('#bull-table').innerHTML = `
    <thead><tr><th>${headTitle}</th>${headCells}</tr></thead>
    <tbody>
      ${row('Revenue growth', rows.map((r, i) => `<td class="num">${r.isActual ? fmtBullPct(r.growthPct) : bullInputCell('growthPct', i - 1, r.growthPct, 0.5)}</td>`).join(''))}
      ${row('Revenue', rows.map((r, i) => bullComputedCell('revenue', i, fmtBullMoney(r.revenue))).join(''))}
      ${row('Net income margin', rows.map((r, i) => {
        if (r.isActual) return `<td class="num">${fmtBullPct(r.marginPct)}</td>`;
        const raw = currentCase().years[i - 1].marginPct;
        const carriedHint = r.marginPct != null ? r.marginPct.toFixed(1) : 'ENTER VALUES';
        return `<td class="num">${bullInputCell('marginPct', i - 1, raw != null ? Number(raw.toFixed(1)) : null, 0.5, carriedHint)}</td>`;
      }).join(''))}
      ${row('Net income', rows.map((r, i) => {
        if (r.isActual) return `<td class="num">${fmtBullMoney(r.netIncome)}</td>`;
        return `<td class="num">${bullNetIncomeInputHtml(i - 1, r.netIncome)}</td>`;
      }).join(''))}
      ${row('EPS', rows.map((r, i) => bullComputedCell('eps', i, fmtBullPrice(r.eps))).join(''))}
      ${row('P/E low est.', rows.map((r, i) => `<td class="num">${r.isActual ? '—' : bullInputCell('peLow', i - 1, r.peLow, 0.5)}</td>`).join(''))}
      ${row('P/E high est.', rows.map((r, i) => `<td class="num">${r.isActual ? '—' : bullInputCell('peHigh', i - 1, r.peHigh, 0.5)}</td>`).join(''))}
      ${row('Share price low', rows.map((r, i) => bullComputedCell('priceLow', i, r.isActual ? '—' : fmtBullPrice(r.priceLow))).join(''), 'bull-row-price')}
      ${row('Share price high', rows.map((r, i) => bullComputedCell('priceHigh', i, r.isActual ? '—' : fmtBullPrice(r.priceHigh))).join(''), 'bull-row-price')}
      ${row('CAGR low', rows.map((r, i) => bullComputedCell('cagrLow', i, r.isActual ? '—' : fmtBullPct(r.cagrLow))).join(''))}
      ${row('CAGR high', rows.map((r, i) => bullComputedCell('cagrHigh', i, r.isActual ? '—' : fmtBullPct(r.cagrHigh))).join(''))}
      ${row('Monetary input', rows.map((r) => `<td class="num">${r.isActual ? bullInvestmentInputHtml() : '—'}</td>`).join(''))}
      ${row('Investment value low', rows.map((r, i) => bullComputedCell('investLow', i, r.investLow != null ? fmtBullMoney(r.investLow) : '—')).join(''), 'bull-row-invest')}
      ${row('Investment value high', rows.map((r, i) => bullComputedCell('investHigh', i, r.investHigh != null ? fmtBullMoney(r.investHigh) : '—')).join(''), 'bull-row-invest')}
    </tbody>`;
  renderBullChart();
  updateBullLockButton();
}

// Share price low/high across the projection years — a filled band between
// the two lines rather than a plain line chart, so the projected range each
// year reads at a glance. The actual (leftmost) column has no P/E-derived
// price, so the chart only ever covers the projection years.
let bullChartHoverPts = [];
function buildBullRangeChartSVG(points) {
  const W = 1000, H = 240, pad = 8;
  let minP = Infinity, maxP = -Infinity;
  for (const { low, high } of points) {
    minP = Math.min(minP, low, high);
    maxP = Math.max(maxP, low, high);
  }
  // Axis always spans at least 50% below to 50% above today's actual price,
  // regardless of how tight the projected range itself is — expanded further
  // (never clamped inward) if a projection actually goes beyond that band.
  if (bullState.price != null) {
    minP = Math.min(minP, bullState.price * 0.5);
    maxP = Math.max(maxP, bullState.price * 1.5);
  }
  const t0 = points[0].ts, t1 = points[points.length - 1].ts;
  const spanT = t1 - t0 || 1;
  const spanP = maxP - minP || 1;
  const x = (ts) => ((ts - t0) / spanT) * W;
  const y = (v) => pad + (1 - (v - minP) / spanP) * (H - 2 * pad);
  let dLow = '', dHigh = '';
  points.forEach(({ ts, low, high }, i) => {
    dLow += (i ? 'L' : 'M') + x(ts).toFixed(1) + ' ' + y(low).toFixed(1);
    dHigh += (i ? 'L' : 'M') + x(ts).toFixed(1) + ' ' + y(high).toFixed(1);
  });
  let band = 'M' + x(points[0].ts).toFixed(1) + ' ' + y(points[0].high).toFixed(1);
  for (let i = 1; i < points.length; i++) band += ' L' + x(points[i].ts).toFixed(1) + ' ' + y(points[i].high).toFixed(1);
  for (let i = points.length - 1; i >= 0; i--) band += ' L' + x(points[i].ts).toFixed(1) + ' ' + y(points[i].low).toFixed(1);
  band += ' Z';
  const hoverPts = points.map(({ ts, low, high, label, isActual, pe }) => ({ ts, low, high, label, isActual, pe, xf: (ts - t0) / spanT, yPixLow: y(low), yPixHigh: y(high) }));
  // A dotted reference line at today's actual price, spanning the full
  // width, so the projected band's position relative to where the stock
  // actually is right now reads at a glance instead of just at the start.
  const refLine = bullState.price != null
    ? `<line class="bull-ref-line" x1="0" y1="${y(bullState.price).toFixed(1)}" x2="${W}" y2="${y(bullState.price).toFixed(1)}"/>`
    : '';
  const svg =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path class="sp-chart-area" d="${band}" fill="#e8b923" opacity="0.16"/>` +
    `<path class="sp-chart-line" d="${dHigh}" stroke="#e8b923"/>` +
    `<path class="sp-chart-line" d="${dLow}" stroke="var(--up)"/>` +
    refLine +
    `</svg>` +
    `<div class="sp-cross" hidden></div>` +
    `<div class="sp-dot bull-dot-high" hidden></div><div class="sp-dot bull-dot-low" hidden></div>` +
    `<div class="sp-hoverbox" hidden></div>`;
  return { svg, hoverPts, minP, maxP };
}
// Y-axis ticks + x-axis year labels live in their own static containers
// (#bull-yaxis / #bull-xaxis) alongside the plot, rather than inside the
// SVG itself — preserveAspectRatio="none" non-uniformly stretches the SVG
// to fill the box, which would distort any text drawn inside it.
const BULL_Y_TICKS = 4;
function renderBullChart() {
  const svgWrap = $('#bull-chart-svgwrap');
  const yaxis = $('#bull-yaxis');
  const xaxis = $('#bull-xaxis');
  // The actual column has no P/E-derived price, but today's real share
  // price is exactly that — plot it as the chart's starting point (low and
  // high collapsed to the same value) so the projected range visibly fans
  // out from where the stock actually is today.
  const rows = bullCompute();
  const points = [];
  if (bullState.price != null) {
    const actualEps = rows[0]?.eps;
    const pe = actualEps ? bullState.price / actualEps : null;
    points.push({ low: bullState.price, high: bullState.price, label: bullState.actual.label, isActual: true, pe });
  }
  rows.forEach((r) => {
    if (!r.isActual && r.priceLow != null && r.priceHigh != null) points.push({ low: r.priceLow, high: r.priceHigh, label: r.label });
  });
  points.forEach((p, i) => { p.ts = i; });
  if (points.length === 0) {
    // No ticker loaded yet — nothing real to plot at all.
    bullChartHoverPts = [];
    svgWrap.innerHTML = '<div class="sp-chart-msg">Load a ticker to see its current price and projected range.</div>';
    yaxis.innerHTML = '';
    xaxis.innerHTML = '';
    return;
  }
  if (points.length === 1) {
    // Only the actual/current price is known so far (data we already have as
    // soon as a ticker loads) — plot it immediately as a flat reference line
    // rather than hiding it behind a message until P/E estimates exist too.
    const only = points[0];
    const flat = [only, { ...only, ts: 1, label: '' }];
    const { svg, hoverPts, minP, maxP } = buildBullRangeChartSVG(flat);
    bullChartHoverPts = [hoverPts[0]];
    svgWrap.innerHTML = svg + '<div class="sp-chart-msg sp-chart-msg-overlay">Enter P/E low and high estimates for at least one projection year to see the projected range.</div>';
    yaxis.innerHTML = Array.from({ length: BULL_Y_TICKS + 1 }, (_, i) => `<span>${fmtBullPrice(maxP - (i * (maxP - minP)) / BULL_Y_TICKS)}</span>`).join('');
    xaxis.innerHTML = `<span>${esc(only.label)}</span>`;
    return;
  }
  const { svg, hoverPts, minP, maxP } = buildBullRangeChartSVG(points);
  bullChartHoverPts = hoverPts;
  svgWrap.innerHTML = svg;
  yaxis.innerHTML = Array.from({ length: BULL_Y_TICKS + 1 }, (_, i) => `<span>${fmtBullPrice(maxP - (i * (maxP - minP)) / BULL_Y_TICKS)}</span>`).join('');
  xaxis.innerHTML = points.map((p) => `<span>${esc(p.label)}</span>`).join('');
}
// Own hover binder (not the shared bindValueChartHover) since this chart
// needs two dots — one sitting on the high line, one on the low line — not
// a single dot at their midpoint.
(() => {
  const plot = $('#bull-chart-svgwrap');
  plot.addEventListener('mousemove', (e) => {
    const pts = bullChartHoverPts;
    const cross = plot.querySelector('.sp-cross');
    const dotHigh = plot.querySelector('.bull-dot-high');
    const dotLow = plot.querySelector('.bull-dot-low');
    const box = plot.querySelector('.sp-hoverbox');
    if (!pts.length || !cross || !dotHigh || !dotLow || !box) return;
    const rect = plot.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    let best = pts[0];
    let bd = Infinity;
    for (const p of pts) { const dd = Math.abs(p.xf - fx); if (dd < bd) { bd = dd; best = p; } }
    const left = best.xf * 100;
    cross.style.left = left + '%'; cross.hidden = false;
    dotHigh.style.left = left + '%'; dotHigh.style.top = best.yPixHigh + 'px'; dotHigh.hidden = false;
    dotLow.style.left = left + '%'; dotLow.style.top = best.yPixLow + 'px'; dotLow.hidden = false;
    box.innerHTML = best.isActual
      ? `<b>${fmtBullPrice(best.low)}</b><span>${esc(best.label)} (current)${best.pe != null ? ' · P/E ' + best.pe.toFixed(1) : ''}</span>`
      : `<b>${fmtBullPrice(best.low)} – ${fmtBullPrice(best.high)}</b><span>${esc(best.label)}</span>`;
    box.style.left = left + '%';
    box.style.transform = best.xf < 0.12 ? 'translateX(0)' : best.xf > 0.88 ? 'translateX(-100%)' : 'translateX(-50%)';
    box.hidden = false;
  });
  plot.addEventListener('mouseleave', () => {
    plot.querySelectorAll('.sp-cross, .sp-dot, .sp-hoverbox').forEach((el) => { el.hidden = true; });
  });
})();
// Patches only the computed cells' text after an edit — the inputs
// themselves are left completely untouched, so focus/caret never moves.
function bullPatchComputedCells() {
  const rows = bullCompute();
  const set = (key, i, text) => { const el = $(`#bull-table [data-cell="${key}"][data-idx="${i}"]`); if (el) el.textContent = text; };
  rows.forEach((r, i) => {
    set('revenue', i, fmtBullMoney(r.revenue));
    set('eps', i, fmtBullPrice(r.eps));
    set('priceLow', i, r.isActual ? '—' : fmtBullPrice(r.priceLow));
    set('priceHigh', i, r.isActual ? '—' : fmtBullPrice(r.priceHigh));
    set('cagrLow', i, r.isActual ? '—' : fmtBullPct(r.cagrLow));
    set('cagrHigh', i, r.isActual ? '—' : fmtBullPct(r.cagrHigh));
    set('investLow', i, r.investLow != null ? fmtBullMoney(r.investLow) : '—');
    set('investHigh', i, r.investHigh != null ? fmtBullMoney(r.investHigh) : '—');
    // Margin placeholder shows what a blank cell will carry forward as —
    // safe to refresh live since changing `placeholder` doesn't touch the
    // input's value, focus, or caret the way changing `value` would.
    if (!r.isActual) {
      const idx = i - 1;
      const marginInput = $(`#bull-table [data-field="marginPct"][data-idx="${idx}"]`);
      if (marginInput) marginInput.placeholder = r.marginPct != null ? r.marginPct.toFixed(1) : 'ENTER VALUES';
      // Net income's value only gets touched here if it's gone stale (its
      // implied margin no longer matches — see bullNetIncomeInputHtml) and
      // it isn't the field currently being typed into, so this never fights
      // the user's own keystrokes.
      const niInput = $(`#bull-table [data-field="netIncome"][data-idx="${idx}"]`);
      if (niInput && document.activeElement !== niInput) {
        const unit = bullState.netIncomeUnit;
        const raw = currentCase().years[idx].netIncomeRaw;
        const fresh = raw != null && r.netIncome != null && Math.abs(raw - r.netIncome) / Math.max(Math.abs(raw), 1) < 0.001;
        niInput.value = fresh ? Number((raw / unit.scale).toFixed(2)) : '';
        niInput.placeholder = r.netIncome != null ? (r.netIncome / unit.scale).toFixed(2) + unit.suffix : 'ENTER VALUES';
      }
    }
  });
  renderBullChart();
}
$('#bull-load').addEventListener('click', () => bullLoadTicker($('#bull-ticker').value));

// Lock button: freezes the current CASE's projection (read-only inputs) and
// saves it server-side keyed by "ticker::case" (see Store.saveBullLock/
// store.js's bull_locks column) so it survives refreshes, logouts/logins,
// and site updates — not just this browser tab's in-memory state. Each case
// locks independently, so Bull can be locked while Standard/Bear stay
// editable. Unlocking deletes the saved copy and re-enables editing.
function bullLockKey(ticker, caseName) { return `${ticker}::${caseName}`; }
function updateBullLockButton() {
  const btn = $('#bull-lock');
  if (!btn) return;
  const hasTicker = !!bullState.ticker;
  const locked = currentCase().locked;
  btn.disabled = !hasTicker;
  btn.textContent = locked ? '🔒 Locked' : '🔓 Lock';
  btn.classList.toggle('bull-locked', !!locked);
  btn.title = locked
    ? 'Unlock to edit this projection again'
    : 'Lock this projection so it persists across refreshes, logouts and logins';
  $('#bull-ticker').disabled = !!locked;
  $('#bull-load').disabled = !!locked;
}
$('#bull-lock').addEventListener('click', async () => {
  if (!bullState.ticker) return;
  const c = currentCase();
  const btn = $('#bull-lock');
  btn.disabled = true;
  const key = bullLockKey(bullState.ticker, bullActiveCase);
  const label = $('#bull-loaded-label');
  const prevLabelText = label ? label.textContent : '';
  try {
    if (c.locked) {
      await Store.deleteBullLock(key);
      c.locked = false;
    } else {
      c.locked = true; // set before saving so the persisted snapshot itself records the locked state
      await Store.saveBullLock(key, { ...bullState, ...c, case: bullActiveCase });
    }
  } catch (e) {
    console.warn('Bull lock toggle failed:', e);
    c.locked = !c.locked; // revert on failure
    // Surface the failure instead of reverting silently — most likely cause
    // is supabase/bull-locks-migration.sql not having been run yet, so the
    // bull_locks column doesn't exist on user_settings.
    if (label) {
      label.textContent = 'Lock failed: ' + (e?.message || e);
      setTimeout(() => { if (label.textContent.startsWith('Lock failed')) label.textContent = prevLabelText; }, 6000);
    }
  }
  updateBullLockButton();
  renderBullTable(); // re-render so inputs pick up the new disabled state
});
// Case tab clicks — just repoints currentCase(), no fetch involved.
$('#bull-case-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.bull-case-tab[data-case]');
  if (!btn || btn.dataset.case === bullActiveCase) return;
  bullActiveCase = btn.dataset.case;
  renderBullTable();
});
$('#bull-ticker').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#bull-ticker-menu').hidden = true; bullLoadTicker($('#bull-ticker').value); }
  if (e.key === 'Escape') { $('#bull-ticker-menu').hidden = true; }
});

// Ticker autocomplete — same debounced Market.search + .ts-item dropdown
// pattern as the Research watchlist's "add a stock" search box.
let bullSearchTimer = null;
function renderBullTickerResults(text) {
  const menu = $('#bull-ticker-menu');
  if (!text || !window.Market) { menu.hidden = true; return; }
  const rows = Market.search(text);
  if (!rows.length) {
    menu.innerHTML = '<div class="ts-empty">No matches.</div>';
    menu.hidden = false;
    return;
  }
  menu.innerHTML = rows
    .map((x) => `<button class="ts-item" data-sym="${esc(x.s)}"><span class="ts-sym">${esc(x.s)}</span><span class="ts-name">${esc(x.n || '')}</span></button>`)
    .join('');
  menu.hidden = false;
}
$('#bull-ticker').addEventListener('input', (e) => {
  clearTimeout(bullSearchTimer);
  const text = e.target.value.trim();
  bullSearchTimer = setTimeout(() => renderBullTickerResults(text), 120);
});
$('#bull-ticker-menu').addEventListener('click', (e) => {
  const item = e.target.closest('.ts-item[data-sym]');
  if (!item) return;
  $('#bull-ticker').value = item.dataset.sym;
  $('#bull-ticker-menu').hidden = true;
  bullLoadTicker(item.dataset.sym);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.bull-ticker-wrap')) $('#bull-ticker-menu').hidden = true;
});
$('#bull-table').addEventListener('input', (e) => {
  const inp = e.target.closest('.bull-input');
  if (!inp) return;
  const field = inp.dataset.field;
  const v = inp.value.trim() === '' ? null : Number(inp.value);
  if (field === 'investment') {
    currentCase().investment = Number.isNaN(v) ? null : v;
    bullPatchComputedCells();
    return;
  }
  const idx = Number(inp.dataset.idx);
  const year = currentCase().years[idx];
  if (field === 'netIncome') {
    // Typing net income directly sets the implied margin % instead, so
    // Revenue -> Margin -> Net income keeps driving everything else exactly
    // as before — this is just a second way to set the same underlying
    // assumption. bullPatchComputedCells' staleness check is what actually
    // keeps this cell in sync if margin/growth get edited afterward.
    const revenueThisYear = bullCompute()[idx + 1]?.revenue;
    const raw = Number.isNaN(v) || v == null ? null : v * bullState.netIncomeUnit.scale;
    year.netIncomeRaw = raw;
    year.marginPct = raw != null && revenueThisYear ? (raw / revenueThisYear) * 100 : null;
  } else {
    year[field] = Number.isNaN(v) ? null : v;
  }
  bullPatchComputedCells();
});

// The Bull case widget also shows up on a stock page's Research &
// Projections tab (see stock.js's loadResearch) — rather than a second copy
// of all the above state/markup, the single #bull-widget DOM node is
// physically relocated between here and wherever it's needed, then moved
// back to #bull-widget-home (its position on the standalone Research page)
// when that page is opened again.
const BullWidget = {
  // chartAnchorSel is optional — only the stock page's Research & Projections
  // tab wants the "Projected share price range" chart pulled out and placed
  // higher up the page (above the Revenue & Projections table, below the two
  // earnings/revenue charts); the standalone Research page just keeps it
  // where it's authored, inside the widget itself.
  attachTo(anchorSel, chartAnchorSel, ticker) {
    const anchor = $(anchorSel);
    const widget = $('#bull-widget');
    if (!anchor || !widget) return;
    anchor.appendChild(widget);
    const chartAnchor = chartAnchorSel && $(chartAnchorSel);
    const chartCard = $('#bull-chart-card');
    if (chartAnchor && chartCard) chartAnchor.appendChild(chartCard);
    if (ticker && ticker !== bullState.ticker) bullLoadTicker(ticker);
    else renderBullTable();
  },
  returnHome() {
    const home = $('#bull-widget-home');
    const widget = $('#bull-widget');
    if (!home || !widget) return;
    home.after(widget);
    const chartHome = $('#bull-chart-card-home');
    const chartCard = $('#bull-chart-card');
    if (chartHome && chartCard) chartHome.after(chartCard);
  },
};
window.BullWidget = BullWidget;

// Compound Calculator: a standalone projection tool, not tied to any
// portfolio's actual holdings — monthly-compounded, monthly contributions.
// The chart's `ts` is a month count (not a real date), so it gets its own
// tooltip formatter — see fmtCalcMonths below.
let calcHoverPts = [];
const fmtCalcMonths = (m) => {
  const y = Math.floor(m / 12), rem = m % 12;
  return `Year ${y}` + (rem ? ` + ${rem}mo` : '');
};
const CompoundPage = {
  show() {
    Nav.push({ type: 'compound' });
    if (window.StockPage) StockPage.close();
    if (window.ConnectorsPage) ConnectorsPage.close();
    if (window.HomePage) HomePage.close();
    if (window.ProfilePage) ProfilePage.close();
    if (window.ResearchPage) ResearchPage.close();
    if (window.EarningsCalendarPage) EarningsCalendarPage.close();
    document.body.classList.add('compound-open');
    $('#compound-page').hidden = false;
    window.scrollTo(0, 0);
    this.render();
  },
  render() {
    const initial = Math.max(0, Number($('#calc-initial').value) || 0);
    const monthly = Math.max(0, Number($('#calc-monthly').value) || 0);
    const rate = Math.max(0, Number($('#calc-rate').value) || 0) / 100;
    const years = Math.max(0, Number($('#calc-years').value) || 0);
    const months = Math.round(years * 12);
    const i = rate / 12;
    const valueAt = (m) => i === 0
      ? initial + monthly * m
      : initial * Math.pow(1 + i, m) + monthly * ((Math.pow(1 + i, m) - 1) / i);
    const fv = valueAt(months);
    const contributed = initial + monthly * months;
    const interest = fv - contributed;
    $('#calc-fv').textContent = fmtNZD(fv);
    $('#calc-contributed').textContent = fmtNZD(contributed);
    $('#calc-interest').textContent = fmtNZD(interest);

    const plot = $('#calc-chart-plot');
    if (months < 12) {
      calcHoverPts = [];
      plot.innerHTML = '<div class="sp-chart-msg">Add more years to see the growth curve.</div>';
      return;
    }
    const points = [];
    for (let m = 0; m <= months; m += 12) points.push({ ts: m, value: valueAt(m), contributed: initial + monthly * m });
    if (points[points.length - 1].ts !== months) points.push({ ts: months, value: fv, contributed });
    const { svg, hoverPts } = buildCompoundChartSVG(points);
    calcHoverPts = hoverPts;
    plot.innerHTML = svg;
  },
  close() {
    document.body.classList.remove('compound-open');
    $('#compound-page').hidden = true;
  },
};
window.CompoundPage = CompoundPage;
bindValueChartHover('#calc-chart-plot', () => calcHoverPts, (best) =>
  `<b>${fmtNZD(best.value)}</b><span>${fmtCalcMonths(best.ts)}</span><span class="calc-hover-contrib">${fmtNZD(best.contributed)} put in</span>`);
$('#rail-compound').addEventListener('click', () => CompoundPage.show());
$('.calc-card').addEventListener('input', () => CompoundPage.render());
// Clicking a note jumps to its portfolio and opens it for editing there —
// research notes are only ever edited in the portfolio they belong to.
$('#research-notes').addEventListener('click', async (e) => {
  const row = e.target.closest('.note[data-note]');
  if (!row) return;
  const { note: noteId, pid } = row.dataset;
  ResearchPage.close();
  if (isAgg() || pid !== activePid) await selectPortfolio(pid);
  const n = state.notes.find((x) => x.id === noteId);
  if (n) openNote(n);
});

// Profile page: just the Google account basics from the Supabase auth
// session (name/email/avatar) — each Google sign-in is already its own
// distinct user_id, scoped by row-level security (see supabase/schema.sql),
// this page just surfaces that identity.
const ProfilePage = {
  show() {
    Nav.push({ type: 'profile' });
    if (window.StockPage) StockPage.close();
    if (window.ConnectorsPage) ConnectorsPage.close();
    if (window.HomePage) HomePage.close();
    if (window.ResearchPage) ResearchPage.close();
    if (window.EarningsCalendarPage) EarningsCalendarPage.close();
    if (window.CompoundPage) CompoundPage.close();
    if (window.SettingsPage) SettingsPage.close();
    document.body.classList.add('profile-open');
    $('#profile-page').hidden = false;
    window.scrollTo(0, 0);
    this.render();
  },
  render() {
    const u = currentUser;
    if (!u) return;
    const meta = u.user_metadata || {};
    const name = meta.full_name || meta.name || (u.email || '').split('@')[0];
    const avatarUrl = meta.avatar_url || meta.picture || '';
    const img = $('#profile-avatar');
    const fallback = $('#profile-avatar-fallback');
    if (avatarUrl) {
      img.src = avatarUrl;
      img.hidden = false;
      fallback.hidden = true;
    } else {
      fallback.textContent = (name[0] || '?').toUpperCase();
      fallback.hidden = false;
      img.hidden = true;
    }
    $('#profile-name').textContent = name;
    $('#profile-email').textContent = u.email || '';
    $('#profile-since').textContent = u.created_at
      ? 'Member since ' + new Date(u.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
      : '';
  },
  close() {
    document.body.classList.remove('profile-open');
    $('#profile-page').hidden = true;
  },
};
window.ProfilePage = ProfilePage;

// Settings page: a menu of rows modelled on other finance apps' settings
// screens (Robinhood / Revolut / Sharesies style). Most rows are
// placeholders — they just toast "not wired up yet" so each one can be kept
// or deleted from index.html's #settings-page. The ones that already do
// something real are marked data-go (jump to an existing page) or
// #settings-logout. Toggles are visual-only for now.
const SettingsPage = {
  show() {
    Nav.push({ type: 'settings' });
    if (window.StockPage) StockPage.close();
    if (window.ConnectorsPage) ConnectorsPage.close();
    if (window.HomePage) HomePage.close();
    if (window.ResearchPage) ResearchPage.close();
    if (window.EarningsCalendarPage) EarningsCalendarPage.close();
    if (window.CompoundPage) CompoundPage.close();
    if (window.ProfilePage) ProfilePage.close();
    document.body.classList.add('settings-open');
    $('#settings-page').hidden = false;
    window.scrollTo(0, 0);
    const u = currentUser;
    if (u) {
      const meta = u.user_metadata || {};
      $('#settings-account-name').textContent = meta.full_name || meta.name || (u.email || '').split('@')[0];
      $('#settings-account-email').textContent = u.email || '';
    }
  },
  close() {
    document.body.classList.remove('settings-open');
    $('#settings-page').hidden = true;
  },
};
window.SettingsPage = SettingsPage;

$('#settings-page').addEventListener('click', (e) => {
  const toggle = e.target.closest('.set-switch');
  if (toggle) {
    const on = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(on));
    return;
  }
  const row = e.target.closest('.set-row');
  if (!row) return;
  if (row.id === 'settings-logout') {
    if (confirm('Log out of Portfolio tracker?')) Store.signOut();
    return;
  }
  const go = row.dataset.go;
  if (go === 'profile') return ProfilePage.show();
  if (go === 'connectors') return ConnectorsPage.show();
  if (row.querySelector('.set-switch')) {
    const sw = row.querySelector('.set-switch');
    sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true'));
    return;
  }
  showToast('Not wired up yet — placeholder', { done: true });
});

// Click the avatar (or its hover hint) to pick a new photo, uploaded to the
// "avatars" Supabase Storage bucket and set as this account's avatar_url.
$('#profile-avatar-wrap').addEventListener('click', () => $('#profile-avatar-input').click());
$('#profile-avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file later
  if (!file || !currentUser) return;
  const errEl = $('#profile-avatar-err');
  errEl.hidden = true;
  try {
    const url = await Store.uploadAvatar(currentUser.id, file);
    currentUser.user_metadata = { ...currentUser.user_metadata, avatar_url: url };
    ProfilePage.render();
    renderTopbarAvatar();
  } catch (err) {
    errEl.textContent = 'Upload failed: ' + (err.message || err);
    errEl.hidden = false;
  }
});

// ---- Appearance: theme (light/dark/system) + accent colour --------------
// The actual values are applied pre-paint by the inline script in
// index.html's <head> (avoids a flash of the wrong theme on load); this is
// just the Profile page UI for changing and persisting them.
const ACCENT_PRESETS = ['#185fa5', '#1d9e75', '#7f77dd', '#d85a30', '#c23b6b', '#0f9aa8'];
// "Colour" theme mode's own customizable variables — the actual page
// background and card surface colour, same idea as Light/Dark picking a
// fixed value for each, except the user picks them directly. Accent is
// handled separately (applyAccent) since it applies the same way across
// every mode.
const CUSTOM_COLOR_KEYS = ['bg', 'surface'];
function loadCustomColors() {
  try { return JSON.parse(localStorage.getItem('cashmoney.customColors') || '{}'); } catch { return {}; }
}

function applyTheme(mode) {
  if (mode === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  localStorage.setItem('cashmoney.theme', mode);
  if (mode === 'colour') {
    // Re-apply whatever was last picked (may be nothing yet, if Colour mode
    // has never been used before — the :root[data-theme='colour'] CSS
    // defaults cover that case).
    const saved = loadCustomColors();
    CUSTOM_COLOR_KEYS.forEach((k) => { if (saved[k]) document.documentElement.style.setProperty('--' + k, saved[k]); });
  } else {
    // Colour mode's inline overrides would otherwise keep beating Light/
    // Dark's own stylesheet values (inline style always wins over a
    // stylesheet rule), so leaving Colour mode would still look like
    // whatever was last picked instead of actually switching — clear them.
    CUSTOM_COLOR_KEYS.forEach((k) => document.documentElement.style.removeProperty('--' + k));
  }
  renderAppearance();
}
function applyAccent(color) {
  document.documentElement.style.setProperty('--accent', color);
  localStorage.setItem('cashmoney.accent', color);
  renderAppearance();
}
function applyCustomColors(obj) {
  CUSTOM_COLOR_KEYS.forEach((k) => { if (obj[k]) document.documentElement.style.setProperty('--' + k, obj[k]); });
  localStorage.setItem('cashmoney.customColors', JSON.stringify(obj));
  renderAppearance();
}
function renderAppearance() {
  const theme = localStorage.getItem('cashmoney.theme') || 'system';
  const accent = localStorage.getItem('cashmoney.accent') || ACCENT_PRESETS[0];
  $('#theme-toggle').querySelectorAll('.theme-btn').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
  $('#accent-swatches').innerHTML = ACCENT_PRESETS
    .map((c) => `<button class="accent-swatch${c === accent ? ' active' : ''}" style="background:${c}" data-accent="${c}" aria-label="${c}"></button>`)
    .join('');
  // Custom colour picker only accepts #rrggbb — keep it in sync with the
  // current accent whenever it's one (a preset click can happen without the
  // picker ever firing its own input event otherwise).
  const picker = $('#accent-picker');
  if (picker && /^#[0-9a-f]{6}$/i.test(accent)) picker.value = accent;

  // Colour mode's own panel — hidden entirely unless that mode is active.
  // Each input's value defaults to whatever's currently in effect (a saved
  // pick, or the :root[data-theme='colour'] CSS default) rather than a blank
  // swatch, so it reads as "this is your current background" from the start.
  const panel = $('#custom-colours');
  if (panel) {
    panel.hidden = theme !== 'colour';
    if (theme === 'colour') {
      const custom = loadCustomColors();
      const cs = getComputedStyle(document.documentElement);
      CUSTOM_COLOR_KEYS.forEach((k) => {
        const input = $(`#custom-color-${k}`);
        if (input) input.value = custom[k] || cs.getPropertyValue('--' + k).trim();
      });
    }
  }
}
$('#theme-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-btn');
  if (btn) applyTheme(btn.dataset.theme);
});
$('#accent-swatches').addEventListener('click', (e) => {
  const btn = e.target.closest('.accent-swatch');
  if (btn) applyAccent(btn.dataset.accent);
});
$('#accent-picker').addEventListener('input', (e) => applyAccent(e.target.value));
CUSTOM_COLOR_KEYS.forEach((k) => {
  const input = $(`#custom-color-${k}`);
  if (input) input.addEventListener('input', (e) => { const obj = loadCustomColors(); obj[k] = e.target.value; applyCustomColors(obj); });
});
renderAppearance();
// Live coverage table: per index — member count, membership source, and how
// many symbols the quote cache currently prices, split by source.
const INDEX_SOURCES = {
  'S&P 500': 'Public datasets CSV (GitHub)',
  'Nasdaq 100': 'Wikipedia',
  'Dow 30': 'Wikipedia',
  'Russell 2000': 'Vanguard VTWO holdings API',
  'FTSE 100': 'Wikipedia → .L symbols',
  'DAX': 'Wikipedia → .DE symbols',
  'Nikkei 225': 'Wikipedia → .T symbols',
  'Unindexed': 'Everything else — no index tag',
  'Major Indices': 'Hardcoded — not in the searchable universe',
};
// Index/commodity levels shown on the ticker strip/Home page — not real
// tickers in the searchable universe (see the "no overlap" check: /api/symbols
// has zero entries for these), so they can't be picked up via x.tags like
// every other row. Kept warm by the same 2s-rotation loop as Currency (see
// the WARM list in server.js) — this row exists purely so you can see that
// happening, same symbols, same source.
const MAJOR_INDICES = ['^GSPC', '^NDX', '^DJI', '^RUT', '^FTSE', '^GDAXI', '^N225', 'DX-Y.NYB', 'GC=F'];
async function renderCoverage(d) {
  const body = $('#coverage-body');
  let universe = (window.Market && Market.all()) || [];
  if (!universe.length) {
    try {
      universe = ((await (await fetch('/api/symbols')).json()).symbols) || [];
    } catch {}
  }
  if (!universe.length) {
    body.innerHTML = '<tr><td colspan="9" class="muted">Stock list not loaded yet.</td></tr>';
    return;
  }
  const quotes = d.quotes || {};
  // When the Yahoo sweep's current lap started (server/yahoo.js) — a Yahoo-
  // sourced quote timestamped at or after this has been refreshed *this
  // lap*, which is what the "Current sweep" column counts, so you can watch
  // it progress through a group live instead of just seeing "Updated" jump
  // once the whole group happens to be caught up.
  const lapStartTs = (d.yahoo || {}).lapStartTs || 0;
  // oldest = the stalest live price in the group, so the whole group is current
  // as of that time (every member updated at or after it).
  const stats = new Map(); // tag -> { members, fh, yh, oldest, lapSwept }
  // Everything with no index tag at all — the vast majority of the universe
  // (~22,000 of ~25,200 symbols). yahoo.js's sweep fills the remainder of its
  // 5,000-symbol cap with these *after* every tagged symbol, in whatever
  // order universe.all() already returns them — alphabetically by ticker
  // (see universe.js's build step), not by market cap, liquidity, or
  // popularity. So "which ones" just means "whichever untagged tickers sort
  // earliest alphabetically" — there's no real selection logic behind it.
  const other = { members: 0, fh: 0, yh: 0, oldest: Infinity, lapSwept: 0 };
  for (const x of universe) {
    if (!x.tags || !x.tags.length) {
      other.members++;
      const q = quotes[x.s];
      if (q) {
        q.source === 'yahoo' ? other.yh++ : other.fh++;
        if (q.ts && q.ts < other.oldest) other.oldest = q.ts;
        if (q.source === 'yahoo' && q.ts >= lapStartTs) other.lapSwept++;
      }
      continue;
    }
    for (const t of x.tags) {
      const s = stats.get(t) || { members: 0, fh: 0, yh: 0, oldest: Infinity, lapSwept: 0 };
      s.members++;
      const q = quotes[x.s];
      if (q) {
        q.source === 'yahoo' ? s.yh++ : s.fh++;
        if (q.ts && q.ts < s.oldest) s.oldest = q.ts;
        if (q.source === 'yahoo' && q.ts >= lapStartTs) s.lapSwept++;
      }
      stats.set(t, s);
    }
  }
  stats.set('Unindexed', other);
  const majorIdx = { members: MAJOR_INDICES.length, fh: 0, yh: 0, oldest: Infinity, lapSwept: 0 };
  for (const sym of MAJOR_INDICES) {
    const q = quotes[sym];
    if (q) {
      q.source === 'yahoo' ? majorIdx.yh++ : majorIdx.fh++;
      if (q.ts && q.ts < majorIdx.oldest) majorIdx.oldest = q.ts;
      if (q.source === 'yahoo' && q.ts >= lapStartTs) majorIdx.lapSwept++;
    }
  }
  stats.set('Major Indices', majorIdx);
  const SYNTHETIC = ['Unindexed', 'Major Indices']; // not real tags — added below, not via the generic tag loop
  const order = Object.keys(INDEX_SOURCES).filter((t) => !SYNTHETIC.includes(t) && stats.has(t));
  for (const t of stats.keys()) if (!order.includes(t) && !SYNTHETIC.includes(t)) order.push(t); // any future tags
  order.push('Major Indices', 'Unindexed'); // always last — the two "everything else" buckets
  const ordered = applyCoverageOrder(order);
  const n = (v) => Number(v).toLocaleString();
  const ago = (ts) => {
    if (!ts || ts === Infinity) return '—';
    const sec = Math.round((Date.now() - ts) / 1000);
    if (sec < 60) return sec + 's ago';
    const min = Math.round(sec / 60);
    if (min < 60) return min + 'm ago';
    return Math.round(min / 60) + 'h ago';
  };
  // Currency and Major Indices aren't touched by the big sweep at all — they're
  // kept warm by server.js's separate WARM loop (one symbol every 2s), which
  // cycles through both groups combined in one rotation, so they share the
  // same full-cycle time regardless of which of the two you're looking at.
  const warmCycleSec = ((stats.get('Currency')?.members || 0) + (stats.get('Major Indices')?.members || 0)) * 2;
  const FAST_TRACK = new Set(['Currency', 'Major Indices']);
  body.innerHTML = ordered
    .map((t) => {
      const s = stats.get(t);
      const sub = FAST_TRACK.has(t) ? `<br><span class="cov-sub">Fast track sweep: ${warmCycleSec}s</span>` : '';
      return `<tr data-tag="${esc(t)}">
        <td class="drag-handle" draggable="true" title="Drag to reorder">⠿</td>
        <td class="sym">${t}${sub}</td>
        <td class="num">${n(s.members)}</td>
        <td class="muted">${INDEX_SOURCES[t] || '—'}</td>
        <td class="num">${n(s.fh + s.yh)}</td>
        <td class="num">${n(s.fh)}</td>
        <td class="num">${n(s.yh)}</td>
        <td class="num">${n(s.lapSwept)} / ${n(s.yh)}</td>
        <td class="num muted">${s.fh + s.yh ? ago(s.oldest) : '—'}</td>
      </tr>`;
    })
    .join('') || '<tr><td colspan="9" class="muted">No index data.</td></tr>';
}

// Drag-to-reorder for the coverage table — same handle-drag pattern as the
// holdings table above, just keyed by tag name instead of a position id.
let coverageDragTag = null;
const coverageBody = $('#coverage-body');
coverageBody.addEventListener('dragstart', (e) => {
  const handle = e.target.closest('.drag-handle');
  const row = handle && handle.closest('tr[data-tag]');
  if (!row) { e.preventDefault(); return; }
  coverageDragTag = row.dataset.tag;
  e.dataTransfer.effectAllowed = 'move';
  row.classList.add('dragging');
});
coverageBody.addEventListener('dragover', (e) => {
  if (!coverageDragTag) return;
  e.preventDefault();
  const row = e.target.closest('tr[data-tag]');
  if (!row || row.dataset.tag === coverageDragTag) return;
  const before = e.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
  coverageBody.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach((r) => r.classList.remove('drag-over-top', 'drag-over-bottom'));
  row.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
});
coverageBody.addEventListener('drop', (e) => {
  e.preventDefault();
  const row = e.target.closest('tr[data-tag]');
  coverageBody.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach((r) => r.classList.remove('drag-over-top', 'drag-over-bottom'));
  if (!coverageDragTag || !row || row.dataset.tag === coverageDragTag) return;
  const before = e.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
  const order = [...coverageBody.querySelectorAll('tr[data-tag]')].map((r) => r.dataset.tag);
  const from = order.indexOf(coverageDragTag);
  order.splice(from, 1);
  const to = order.indexOf(row.dataset.tag) + (before ? 0 : 1);
  order.splice(to, 0, coverageDragTag);
  saveCoverageOrder(order);
  // Also tell the server, so the Yahoo sweep (Finnhub's hot set is separate
  // and unaffected) actually sweeps groups in this order, not just the
  // display order — see setPriorityOrder in server/yahoo.js.
  fetch('/api/coverage-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }) }).catch(() => {});
  if (lastCoverageData) renderCoverage(lastCoverageData);
});
coverageBody.addEventListener('dragend', () => {
  coverageDragTag = null;
  coverageBody.querySelectorAll('.dragging, .drag-over-top, .drag-over-bottom').forEach((r) => r.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom'));
});

// ---- Sharesies connector: login (+ 2FA) is a deliberate, un-persisted
// action — nothing is saved between server restarts, so every sync starts
// with the user re-entering credentials/code. See server/sharesies.js.
async function refreshSharesiesStatus() {
  const el = $('#sharesies-status');
  let d;
  try {
    d = await (await sharesiesFetch('/api/sharesies/status')).json();
  } catch {
    d = { connected: false, pending: false };
  }
  if (d.connected) {
    el.className = 'connector-status on';
    el.innerHTML = '<span class="dot"></span>Connected';
  } else if (d.pending) {
    el.className = 'connector-status stale';
    el.innerHTML = '<span class="dot"></span>Awaiting 2FA code';
  } else {
    el.className = 'connector-status off';
    el.innerHTML = '<span class="dot"></span>Not connected';
  }
  renderSharesiesDetail(d);
}

function renderSharesiesDetail(d) {
  const box = $('#sharesies-detail');
  if (d.connected) {
    box.innerHTML = `<div class="conn-grid">
      <span class="conn-k">Status</span><span class="conn-v">Connected (session in memory — lost on server restart)</span>
      <span class="conn-k">Role</span><span class="conn-v">One-off holdings import (ticker, shares, cost basis) — prices come from Finnhub/Yahoo once imported</span>
    </div>
    <button type="button" class="btn" id="sharesies-disconnect">Disconnect</button>`;
    $('#sharesies-disconnect').addEventListener('click', async () => {
      await sharesiesFetch('/api/sharesies/logout', { method: 'POST' }).catch(() => {});
      refreshSharesiesStatus();
    });
  } else if (d.pending) {
    box.innerHTML = `<form id="sharesies-2fa-form" class="conn-form">
      <label>2FA code<input id="sharesies-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required /></label>
      <button type="submit" class="btn btn-dark">Verify</button>
      <p class="login-err" id="sharesies-err" hidden></p>
    </form>`;
    $('#sharesies-2fa-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('#sharesies-code').value.trim();
      const errEl = $('#sharesies-err');
      errEl.hidden = true;
      try {
        const r = await sharesiesFetch('/api/sharesies/2fa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || 'Verification failed');
        refreshSharesiesStatus();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });
  } else {
    box.innerHTML = `<form id="sharesies-login-form" class="conn-form">
      <label>Email<input id="sharesies-email" type="email" autocomplete="off" required /></label>
      <label>Password<input id="sharesies-password" type="password" autocomplete="off" required /></label>
      <button type="submit" class="btn btn-dark">Connect</button>
      <p class="login-err" id="sharesies-err" hidden></p>
      <p class="muted">Nothing is stored — you'll enter this again after a server restart.</p>
    </form>`;
    $('#sharesies-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#sharesies-email').value.trim();
      const password = $('#sharesies-password').value;
      const errEl = $('#sharesies-err');
      errEl.hidden = true;
      try {
        const r = await sharesiesFetch('/api/sharesies/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || 'Login failed');
        refreshSharesiesStatus();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });
  }
}

// ---- Import portfolio dialog: fetch Sharesies holdings, let the user pick
// which ones to add as new positions in the currently open portfolio.
const importDialog = $('#import-dialog');
const PRODUCT_LABEL = { INVEST: 'Investments', KIWISAVER: 'KiwiSaver', SAVE: 'Save', WALLET: 'Wallet (cash)' };

$('#import-btn').addEventListener('click', async () => {
  const body = $('#import-body');
  const confirmBtn = $('#import-confirm');
  confirmBtn.hidden = true;
  body.innerHTML = '<h3>Import portfolio</h3><p class="muted" id="import-msg">Checking connectors…</p>';
  importDialog.showModal();

  const st = await (await sharesiesFetch('/api/sharesies/status')).json().catch(() => ({}));
  if (!st.connected) {
    body.innerHTML = `<h3>Import portfolio</h3><p class="muted">Connect Sharesies first — open <b>Connectors</b> in the side rail and log in.</p>`;
    return;
  }
  body.innerHTML = '<h3>Import portfolio</h3><p class="muted">Loading your Sharesies accounts…</p>';
  let products;
  try {
    const r = await sharesiesFetch('/api/sharesies/products');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed to load accounts');
    products = d.products || [];
  } catch (err) {
    body.innerHTML = `<h3>Import portfolio</h3><p class="login-err">${err.message}</p>`;
    return;
  }
  if (!products.length) {
    body.innerHTML = '<h3>Import portfolio</h3><p class="muted">No Sharesies accounts found.</p>';
    return;
  }
  // A Sharesies login has several products (Invest, KiwiSaver, Save, Wallet)
  // — pick which one feeds this app portfolio before pulling holdings.
  body.innerHTML = `<h3>Import from Sharesies</h3>
    <p class="muted">Which Sharesies account?</p>
    <div class="import-list">${products.map((p, i) => `
      <label class="import-row">
        <input type="radio" name="sharesies-product" data-idx="${i}" ${i === 0 ? 'checked' : ''} />
        <span class="sym">${PRODUCT_LABEL[p.product] || p.name}</span>
        <span class="muted">${p.name} — $${p.balance.toLocaleString()}</span>
      </label>`).join('')}
    </div>`;
  confirmBtn.hidden = false;
  confirmBtn.textContent = 'Next';
  confirmBtn.onclick = () => loadHoldingsFor(products[Number(body.querySelector('input:checked').dataset.idx)]);
});

async function loadHoldingsFor(product) {
  const body = $('#import-body');
  const confirmBtn = $('#import-confirm');
  confirmBtn.hidden = true;
  body.innerHTML = `<h3>Import from Sharesies</h3><p class="muted">Loading ${esc(PRODUCT_LABEL[product.product] || product.name)}…</p>`;
  let holdings;
  try {
    const r = await sharesiesFetch('/api/sharesies/holdings?portfolioId=' + encodeURIComponent(product.id));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed to load holdings');
    holdings = d.holdings || [];
  } catch (err) {
    body.innerHTML = `<h3>Import from Sharesies</h3><p class="login-err">${err.message}</p>`;
    return;
  }
  if (!holdings.length) {
    body.innerHTML = `<h3>Import from Sharesies</h3><p class="muted">No holdings in ${esc(PRODUCT_LABEL[product.product] || product.name)}.</p>`;
    return;
  }
  body.innerHTML = `<h3>Import from Sharesies — ${esc(PRODUCT_LABEL[product.product] || product.name)}</h3>
    <div class="import-list">${holdings.map((h, i) => `
      <label class="import-row">
        <input type="checkbox" data-idx="${i}" checked />
        <span class="sym">${cashLabel(h.ticker) ? esc(cashLabel(h.ticker)) : h.ticker}</span>
        <span class="muted">${cashLabel(h.ticker) ? window.fmtMoney(h.ticker, h.price) : `${h.shares} sh @ avg $${h.cost.toFixed(2)}`}</span>
      </label>`).join('')}
    </div>`;
  confirmBtn.hidden = false;
  confirmBtn.textContent = 'Import selected';
  confirmBtn.onclick = async () => {
    const checked = [...body.querySelectorAll('input[type=checkbox]:checked')].map((c) => holdings[c.dataset.idx]);
    // Update in place if this ticker's already a position (e.g. re-running
    // Import after adding a Sharesies connector to an already-imported
    // portfolio) — otherwise Import doubles every holding instead of
    // refreshing it.
    for (const h of checked) {
      const existing = state.positions.find((p) => p.ticker === h.ticker);
      // h.price is only set for cash-like holdings (Wallet/Save/KiwiSaver —
      // see getCashLikeHolding in sharesies.js); real stock tickers get 0
      // and Finnhub/Yahoo fills it in within seconds after import.
      if (existing) { existing.shares = h.shares; existing.cost = h.cost; if (h.price != null) existing.price = h.price; }
      else state.positions.push({ id: Store.id(), ticker: h.ticker, shares: h.shares, cost: h.cost, price: h.price ?? 0, day: 0, category: '' });
    }
    importDialog.close();
    if (!checked.length) return;
    render(); // saves positions via Store.save inside render()

    // Mark this portfolio Sharesies-linked to this specific product
    // immediately — this is what Refresh checks (refreshSharesiesLink) to
    // decide whether, and which id, to re-sync, and must not depend on the
    // history snapshot below, which can fail on its own without the
    // holdings import having failed.
    if (!isAgg()) {
      try {
        await Store.markSharesiesLinked(activePid, product.id);
        const linked = portfolios.find((x) => x.id === activePid);
        if (linked) { linked.sharesies_linked = true; linked.sharesies_portfolio_id = product.id; }
      } catch (e) {
        console.warn('Marking portfolio Sharesies-linked failed:', e);
      }
    }

    // Also snapshot Sharesies' own value-history chart (not meaningful for
    // Wallet/Save — see getPortfolioHistory, which returns empty for those),
    // so it's visible on this portfolio going forward even after
    // disconnecting — see renderSharesiesChart. Best-effort: a failure here
    // shouldn't undo the position import that already succeeded above.
    try {
      const hr = await sharesiesFetch('/api/sharesies/history?portfolioId=' + encodeURIComponent(product.id));
      const hd = await hr.json();
      if (hr.ok && hd.history?.length && !isAgg()) {
        await Store.saveSharesiesHistory(activePid, hd.history);
        const p = portfolios.find((x) => x.id === activePid);
        if (p) { p.sharesies_history = hd.history; p.sharesies_synced_at = new Date().toISOString(); }
        renderSharesiesChart();
      }
    } catch (e) {
      console.warn('Sharesies history snapshot failed:', e);
    }
  };
}
$('#import-cancel').addEventListener('click', () => importDialog.close());

// Expand/collapse a connector's detail panel.
$('#connectors-page').addEventListener('click', (e) => {
  const head = e.target.closest('.connector-head');
  if (!head) return;
  const card = head.closest('.connector');
  const detail = $(`#${head.dataset.conn}-detail`);
  const open = detail.hidden;
  detail.hidden = !open;
  card.classList.toggle('open', open);
});
$('#rail-settings').addEventListener('click', () => SettingsPage.show());

const pfTabs = $('#portfolio-tabs');
pfTabs.addEventListener('click', async (e) => {
  const delId = e.target.closest('[data-del-pf]')?.dataset.delPf;
  if (delId) return deletePortfolio(delId);
  if (e.target.closest('[data-new]')) return openNewPortfolio();
  const tab = e.target.closest('.pf-tab[data-pid]');
  if (tab) {
    const pid = tab.dataset.pid;
    if (isAgg() || pid !== activePid) await selectPortfolio(pid);
    else {
      // Re-clicking the open tab still leaves any overlay page.
      if (window.StockPage) StockPage.close();
      if (window.ConnectorsPage) ConnectorsPage.close();
      if (window.ProfilePage) ProfilePage.close();
      if (window.ResearchPage) ResearchPage.close();
      if (window.EarningsCalendarPage) EarningsCalendarPage.close();
      if (window.CompoundPage) CompoundPage.close();
      if (window.SettingsPage) SettingsPage.close();
    }
  }
});
pfTabs.addEventListener('dblclick', (e) => {
  const tab = e.target.closest('.pf-tab[data-pid]');
  if (tab) openRenamePortfolio(tab.dataset.pid);
});

// Drag-to-reorder tabs — a genuine drag doesn't fire click/dblclick, so this
// coexists with open/rename/delete above without a separate handle. Order is
// a local display preference (see applyPortfolioOrder/savePortfolioOrder).
let dragPfId = null;
function clearTabDragMarkers() {
  pfTabs.querySelectorAll('.dragging, .pf-tab-drag-before, .pf-tab-drag-after')
    .forEach((t) => t.classList.remove('dragging', 'pf-tab-drag-before', 'pf-tab-drag-after'));
}
pfTabs.addEventListener('dragstart', (e) => {
  const tab = e.target.closest('.pf-tab[data-pid]');
  if (!tab) { e.preventDefault(); return; }
  dragPfId = tab.dataset.pid;
  e.dataTransfer.effectAllowed = 'move';
  tab.classList.add('dragging');
});
pfTabs.addEventListener('dragover', (e) => {
  if (!dragPfId) return;
  e.preventDefault();
  const tab = e.target.closest('.pf-tab[data-pid]');
  if (!tab || tab.dataset.pid === dragPfId) return;
  const before = e.clientX < tab.getBoundingClientRect().left + tab.offsetWidth / 2;
  pfTabs.querySelectorAll('.pf-tab-drag-before, .pf-tab-drag-after').forEach((t) => t.classList.remove('pf-tab-drag-before', 'pf-tab-drag-after'));
  tab.classList.add(before ? 'pf-tab-drag-before' : 'pf-tab-drag-after');
});
pfTabs.addEventListener('drop', (e) => {
  e.preventDefault();
  const tab = e.target.closest('.pf-tab[data-pid]');
  clearTabDragMarkers();
  if (!dragPfId || !tab || tab.dataset.pid === dragPfId) return;
  const before = e.clientX < tab.getBoundingClientRect().left + tab.offsetWidth / 2;
  const from = portfolios.findIndex((p) => p.id === dragPfId);
  if (from < 0) return;
  const [moved] = portfolios.splice(from, 1);
  const to = portfolios.findIndex((p) => p.id === tab.dataset.pid) + (before ? 0 : 1);
  portfolios.splice(to, 0, moved);
  savePortfolioOrder();
  renderPortfolioTabs();
});
pfTabs.addEventListener('dragend', () => {
  dragPfId = null;
  clearTabDragMarkers();
});

// Right-click a tab to pick its colour, from the same palette used for
// allocation chart slices (see PALETTE at the top of this file).
const tabColorMenu = $('#tab-color-menu');
let colorMenuPid = null;
pfTabs.addEventListener('contextmenu', (e) => {
  const tab = e.target.closest('.pf-tab[data-pid]');
  if (!tab) return;
  e.preventDefault();
  colorMenuPid = tab.dataset.pid;
  const current = getTabColors()[colorMenuPid];
  tabColorMenu.innerHTML =
    PALETTE.map((c) => `<button class="tab-color-swatch${c === current ? ' active' : ''}" style="background:${c}" data-color="${c}" aria-label="${c}"></button>`).join('') +
    `<button class="tab-color-swatch tab-color-none${!current ? ' active' : ''}" data-color="" title="No colour" aria-label="No colour">×</button>`;
  tabColorMenu.style.left = e.clientX + 'px';
  tabColorMenu.style.top = e.clientY + 'px';
  tabColorMenu.hidden = false;
});
tabColorMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-color]');
  if (!btn || !colorMenuPid) return;
  setTabColor(colorMenuPid, btn.dataset.color || null);
  tabColorMenu.hidden = true;
  renderPortfolioTabs();
});
document.addEventListener('click', (e) => {
  if (!tabColorMenu.hidden && !e.target.closest('#tab-color-menu')) tabColorMenu.hidden = true;
});

const pfDialog = $('#portfolio-dialog');
let editingPid = null; // null = creating, else renaming this portfolio

function openNewPortfolio() {
  editingPid = null;
  $('#pf-title').textContent = 'New portfolio';
  $('#pf-save').textContent = 'Create';
  $('#pf-name').value = '';
  pfDialog.showModal();
  $('#pf-name').focus();
}
function openRenamePortfolio(pid) {
  const p = portfolios.find((x) => x.id === pid);
  if (!p) return;
  editingPid = pid;
  $('#pf-title').textContent = 'Rename portfolio';
  $('#pf-save').textContent = 'Save';
  $('#pf-name').value = p.name;
  pfDialog.showModal();
  $('#pf-name').select();
}
$('#pf-cancel').addEventListener('click', () => pfDialog.close());
$('#portfolio-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#pf-name').value.trim();
  if (!name) return;
  pfDialog.close();
  try {
    if (editingPid) {
      await Store.renamePortfolio(editingPid, name);
      const p = portfolios.find((x) => x.id === editingPid);
      if (p) p.name = name;
      renderPortfolioTabs();
    } else {
      const pid = Store.id();
      await Store.createPortfolio(name, pid);
      portfolios.push({ id: pid, name });
      await selectPortfolio(pid); // new portfolios start empty
    }
  } catch (err) {
    console.error('Save portfolio failed:', err);
  }
});

async function deletePortfolio(pid) {
  if (portfolios.length <= 1) return; // never delete the last one
  const p = portfolios.find((x) => x.id === pid);
  if (!p) return;
  if (!confirm(`Delete “${p.name}” and all its holdings and notes? This can't be undone.`)) return;
  try {
    await Store.deletePortfolio(pid);
    portfolios = portfolios.filter((x) => x.id !== pid);
    if (pid === activePid) await selectPortfolio(portfolios[0].id);
    else if (isAgg()) await selectPortfolio(AGG); // refresh the merged view
  } catch (err) {
    console.error('Delete portfolio failed:', err);
  }
}

$('#google-btn').addEventListener('click', async () => {
  const err = $('#login-err');
  err.hidden = true;
  const { error } = await Store.signInWithGoogle();
  if (error) {
    err.textContent = error.message;
    err.hidden = false;
  }
});

$('#signout-btn').addEventListener('click', () => Store.signOut());

// ---- Topbar stock search --------------------------------------------------
// Searches the full universe (via market.js) and opens the stock detail panel.
const topSearch = $('#top-search');
const topMenu = $('#top-search-menu');
let topTimer;

const tsPrice = (s, q) => (q ? window.fmtMoney(s, q.price) : '');
const tsStar = (s) => (window.Favourites && Favourites.has(s) ? '★' : '☆');

async function renderTopResults(text) {
  if (!text || !window.Market) {
    topMenu.hidden = true;
    return;
  }
  const rows = Market.search(text);
  if (!rows.length) {
    topMenu.innerHTML = '<div class="ts-empty">No matches.</div>';
    topMenu.hidden = false;
    return;
  }
  const syms = rows.map((x) => x.s);
  topMenu.innerHTML = rows
    .map((x) => `<button class="ts-item" data-sym="${esc(x.s)}">
        <span class="ts-sym">${esc(x.s)}</span>
        <span class="ts-name">${esc(x.n || '')}</span>
        <span class="ts-price" data-price="${esc(x.s)}"></span>
        <span class="ts-fav ${Favourites && Favourites.has(x.s) ? 'on' : ''}" data-fav="${esc(x.s)}" role="button" title="Toggle favourite">${tsStar(x.s)}</span>
      </button>`)
    .join('');
  topMenu.hidden = false;
  // Fill the most recent prices (read-only peek — doesn't touch the hot set).
  try {
    const q = ((await (await fetch('/api/peek?symbols=' + encodeURIComponent(syms.join(',')))).json()).quotes) || {};
    for (const s of syms) {
      const el = topMenu.querySelector(`[data-price="${cssEsc(s)}"]`);
      if (el && q[s]) el.textContent = tsPrice(s, q[s]);
    }
  } catch {}
}
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

topSearch.addEventListener('input', () => {
  clearTimeout(topTimer);
  topTimer = setTimeout(() => renderTopResults(topSearch.value.trim()), 120);
});
topSearch.addEventListener('focus', () => renderTopResults(topSearch.value.trim()));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.top-search')) topMenu.hidden = true;
});
topMenu.addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    e.stopPropagation();
    const on = window.Favourites && Favourites.toggle(fav.dataset.fav);
    fav.textContent = on ? '★' : '☆';
    fav.classList.toggle('on', !!on);
    return;
  }
  const item = e.target.closest('.ts-item');
  if (!item) return;
  topMenu.hidden = true;
  topSearch.value = '';
  if (window.Market) Market.openDetail(item.dataset.sym);
});

// ---- Favourites dropdown (star left of the search bar) ------------------
const favOpen = $('#fav-open');
const favMenu = $('#fav-menu');
async function renderFavMenu() {
  const syms = window.Favourites ? Favourites.list() : [];
  if (!syms.length) {
    favMenu.innerHTML = '<div class="fav-empty">No favourites yet.<br>Open a stock and tap ☆ to add.</div>';
    return;
  }
  let quotes = {};
  try {
    quotes = ((await (await fetch('/api/quotes?symbols=' + encodeURIComponent(syms.join(',')))).json()).quotes) || {};
  } catch {}
  favMenu.innerHTML = syms
    .map((s) => {
      const meta = (window.Market && Market.get(s)) || { n: '' };
      const q = quotes[s];
      const price = q ? window.fmtMoney(s, q.price) : '—';
      const day = q ? q.day : null;
      const cls = day == null ? '' : day > 0 ? 'up' : day < 0 ? 'down' : '';
      const dtxt = day == null ? '' : (day >= 0 ? '+' : '−') + Math.abs(day).toFixed(2) + '%';
      return `<div class="fav-row" data-sym="${esc(s)}">
        <span class="fav-sym">${esc(s)}<span class="fav-name">${esc(meta.n || '')}</span></span>
        <span class="fav-price">${price}</span>
        <span class="fav-day ${cls}">${dtxt}</span>
        <button class="fav-x" data-remove="${esc(s)}" title="Remove favourite">×</button>
      </div>`;
    })
    .join('');
}
favOpen.addEventListener('click', async (e) => {
  e.stopPropagation();
  topMenu.hidden = true;
  if (favMenu.hidden) {
    await renderFavMenu();
    favMenu.hidden = false;
  } else {
    favMenu.hidden = true;
  }
});
favMenu.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    e.stopPropagation();
    if (window.Favourites) Favourites.remove(rm.dataset.remove);
    renderFavMenu();
    return;
  }
  const row = e.target.closest('.fav-row');
  if (row) {
    favMenu.hidden = true;
    if (window.StockPage) StockPage.show(row.dataset.sym);
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#fav-menu') && e.target !== favOpen) favMenu.hidden = true;
});

const App = {
  // Called from the S&P 500 board's "Add to holdings" button.
  addFromMarket(symbol, price) {
    if (isAgg()) {
      alert('Switch to one of your portfolios to add a holding.');
      return;
    }
    openPosition(null);
    $('#f-ticker').value = symbol;
    if (price) $('#f-price').value = Number(price).toFixed(2);
  },
  // One-click add from the in-portfolio search: drops the stock straight into
  // the open portfolio at the live price with 0 shares (edit the row to set
  // shares/cost). No dialog.
  quickAdd(symbol, price) {
    if (isAgg()) {
      alert('Switch to one of your portfolios to add a holding.');
      return false;
    }
    if (state.positions.some((p) => p.ticker === symbol)) return false; // already held
    state.positions.push({ id: Store.id(), ticker: symbol, shares: 0, cost: 0, price: Number(price) || 0, day: 0, category: '' });
    render();
    return true;
  },
  boot() {
    // Fires immediately with the current session, and again on sign in/out.
    Store.onAuth((session) => {
      if (session && session.user) showApp(session.user);
      else showLogin();
    });
  },
};
window.App = App;

// ---- Display currency dropdown (on the Total value card) ----------------
(function setupCurrency() {
  const metrics = $('#metrics');
  if (!metrics) return;
  // The metrics HTML is re-rendered often, so use delegation.
  metrics.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-ccy-trigger]');
    if (trigger) {
      e.stopPropagation();
      const menu = $('#ccy-menu');
      if (menu) menu.hidden = !menu.hidden;
      return;
    }
    const item = e.target.closest('[data-ccy]');
    if (item) {
      Currency.display = item.dataset.ccy;
      render(); // rebuilds metrics (menu closes) and re-converts everything
    }
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('.ccy-trigger') || e.target.closest('#ccy-menu')) return;
    const menu = $('#ccy-menu');
    if (menu) menu.hidden = true;
  });
  // Load FX rates, then re-render converted; refresh every 5 min (FX moves slowly).
  const loadAndRender = () => Currency.loadRates().then(() => { if (ready) render(); });
  loadAndRender();
  setInterval(loadAndRender, 5 * 60 * 1000);
})();
