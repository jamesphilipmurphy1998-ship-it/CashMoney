// stock.js — the individual stock page (Yahoo-style summary).
//
// Opened by clicking a stock anywhere (topbar search, Search list, ticker
// strip). Live fields come from /api/stock/<sym> — quote, profile, and basic
// financials. Fields the free data tier doesn't cover (bid/ask, volume,
// earnings date, dividends, 1y target, the chart) render as unpopulated
// placeholders until we have a source for them.

(() => {
  const $ = (s) => document.querySelector(s);
  const page = $('#stock-page');
  if (!page) return;

  let current = null; // symbol being shown
  let lastPrice = null; // for "+ Add to holdings"

  // ── favourites ─────────────────────────────────────────────────────────
  // Starred symbols are pinned to Finnhub's live-refresh hot set. Requesting a
  // symbol from /api/quotes registers it server-side (ensureWatched), so we
  // "register" a favourite by fetching it — and re-register on load / on a
  // timer so they survive a server restart while the page stays open.
  const FAV_KEY = 'cashmoney.favourites';
  const loadFavs = () => { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); } };
  let favs = loadFavs();
  const saveFavs = () => localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  const registerFavs = (syms) => { if (syms.length) fetch('/api/quotes?symbols=' + encodeURIComponent(syms.join(','))).catch(() => {}); };
  function reflectFav(sym) {
    const b = $('#sp-fav');
    const on = favs.has(sym);
    b.classList.toggle('on', on);
    b.textContent = on ? '★' : '☆';
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Favourited — kept on Finnhub live refresh. Click to remove.' : 'Add to favourites — keeps this stock on Finnhub live refresh';
  }

  // Currency follows the open symbol (¥ for .T, pence for .L, € for .DE, …).
  const money = (n) => (n || n === 0 ? window.fmtMoney(current, n) : '—');
  const num = (n, d = 2) => (n || n === 0 ? Number(n).toLocaleString('en-US', { maximumFractionDigits: d }) : '—');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Market cap arrives in millions from Finnhub.
  function fmtCap(m) {
    if (!m) return '—';
    if (m >= 1e6) return '$' + (m / 1e6).toFixed(3) + 'T';
    if (m >= 1e3) return '$' + (m / 1e3).toFixed(2) + 'B';
    return '$' + m.toFixed(0) + 'M';
  }

  function statCells(q, met, cap) {
    const range = q && q.low && q.high ? `${num(q.low)} – ${num(q.high)}` : '—';
    const r52 = met && met.low52 && met.high52 ? `${num(met.low52)} – ${num(met.high52)}` : '—';
    const avgVol = met && met.avgVol10d ? num(met.avgVol10d * 1e6, 0) : '—';
    return [
      ['Previous close', q ? money(q.prevClose) : '—'],
      ['Open', q && q.open ? money(q.open) : '—'],
      ['Bid', '—'],
      ['Ask', '—'],
      ["Day's range", range],
      ['52-week range', r52],
      ['Volume', '—'],
      ['Avg. volume (10d)', avgVol],
      ['Market cap', fmtCap(cap)],
      ['Beta', met ? num(met.beta) : '—'],
      ['PE ratio (TTM)', met ? num(met.pe) : '—'],
      ['EPS (TTM)', met ? num(met.eps) : '—'],
      ['Earnings date', '—'],
      ['Forward dividend & yield', met && met.divYield ? num(met.divYield) + '%' : '—'],
      ['Ex-dividend date', '—'],
      ['1y target est', '—'],
    ];
  }

  function renderQuote(q) {
    $('#sp-page-price').textContent = q ? num(q.price) : '—';
    const chgEl = $('#sp-page-chg');
    if (q && q.prevClose) {
      const chg = q.price - q.prevClose;
      const sign = chg >= 0 ? '+' : '−';
      chgEl.textContent = `${sign}${Math.abs(chg).toFixed(2)} (${sign}${Math.abs(q.day).toFixed(2)}%)`;
      chgEl.className = 'sp-big-chg ' + (chg > 0 ? 'up' : chg < 0 ? 'down' : '');
    } else {
      chgEl.textContent = '';
      chgEl.className = 'sp-big-chg';
    }
    $('#sp-page-asof').textContent = q && q.ts ? 'As of ' + new Date(q.ts).toLocaleTimeString() : '';
  }

  // opts: { name, isIndex } — indices (e.g. ^GSPC) are opened from the ticker
  // strip. They can't be held or favourited, so those controls are hidden and
  // the header shows the index name with its symbol beneath.
  async function show(sym, opts = {}) {
    if (window.Nav) Nav.push({ type: 'stock', sym, opts });
    current = sym;
    // Indices/FX/commodities (^GSPC, NZDUSD=X, GC=F, DX-Y.NYB) aren't holdings,
    // whether opened from the ticker strip or found via search.
    const isIndex = opts.isIndex || /(\^|=X$|=F$|\.NYB$)/.test(sym);
    const meta = (window.Market && Market.get(sym)) || { s: sym, n: opts.name || '', tags: [] };

    if (window.ConnectorsPage) ConnectorsPage.close(); // one page at a time
    if (window.HomePage) HomePage.close();
    if (window.ProfilePage) ProfilePage.close();
    if (window.ResearchPage) ResearchPage.close();
    if (window.EarningsCalendarPage) EarningsCalendarPage.close();
    if (window.CompoundPage) CompoundPage.close();
    document.body.classList.add('stock-open');
    page.hidden = false;
    window.scrollTo(0, 0);
    // Lands on Summary by default, regardless of which section was open last
    // time — except when opened from the Research page's watchlist, which
    // asks for opts.tab: 'research' instead. Every other entry point (search,
    // ticker strip, quick-add, etc.) always opens Summary.
    const tab = opts.tab === 'research' ? 'research' : 'summary';
    document.querySelectorAll('.sp-nav-item[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#sp-tab-summary').hidden = tab !== 'summary';
    $('#sp-tab-research').hidden = tab !== 'research';
    $('#sp-tab-financials').hidden = true;
    $('#sp-tab-analysis').hidden = true;
    if (tab === 'research') loadResearch();

    // Indices can't be added to holdings or favourited.
    $('#sp-page-add').style.display = isIndex ? 'none' : '';
    $('#sp-fav').style.display = isIndex ? 'none' : '';

    // Immediate paint from what we know; live data fills in below.
    $('#sp-page-symbol').textContent = isIndex ? (opts.name || sym) : sym;
    if (!isIndex) reflectFav(sym);
    // Logo only exists for companies (Finnhub profile), not indices — cleared
    // here so the previous symbol's logo doesn't flash before the new one
    // (or "no logo") loads below.
    const logoImg = $('#sp-page-logo');
    logoImg.hidden = true;
    logoImg.src = '';
    $('#sp-page-name').textContent = isIndex ? sym : (meta.n || '');
    $('#sp-page-tags').innerHTML = isIndex
      ? '<span class="tag">Index</span>'
      : (meta.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    renderQuote(null);
    $('#sp-stats').innerHTML = statCells(null, null, 0)
      .map(([k, v]) => `<div class="sp-cell"><span class="sp-k">${k}</span><span class="sp-v">${v}</span></div>`)
      .join('');
    $('#sp-ov-title').textContent = (meta.n || sym) + ' Overview';
    $('#sp-ov-body').textContent = '—';
    loadChart(sym);

    try {
      const r = await fetch('/api/stock/' + encodeURIComponent(sym));
      const d = await r.json();
      if (current !== sym) return; // user moved on
      const q = d.quote;
      const p = d.profile;
      lastPrice = q ? q.price : null;
      renderQuote(q);
      $('#sp-stats').innerHTML = statCells(q, d.metrics, p ? p.marketCap : 0)
        .map(([k, v]) => `<div class="sp-cell"><span class="sp-k">${k}</span><span class="sp-v">${v}</span></div>`)
        .join('');
      const bits = [meta.sec, p && p.industry, p && p.exchange].filter(Boolean);
      $('#sp-ov-body').textContent = bits.length ? bits.join(' · ') : '—';
      if (p && p.name && !meta.n) $('#sp-page-name').textContent = p.name;
      if (!isIndex && p && p.logo) {
        logoImg.onerror = () => { logoImg.hidden = true; };
        logoImg.src = p.logo;
        logoImg.hidden = false;
      }
    } catch {
      // placeholders stay
    }
  }

  // ── chart ──────────────────────────────────────────────────────────────
  const RANGE_MS = {
    '1D': 1 * 864e5, '5D': 5 * 864e5, '1M': 30 * 864e5, '6M': 182 * 864e5,
    '1Y': 365 * 864e5, '5Y': 5 * 365 * 864e5, All: Infinity,
  };
  let chartPoints = []; // [ts, price] oldest first, for `current`
  let chartRange = '1Y';
  let intradayPoints = null; // today's real 1-min bars from /api/intraday, only for the 1D range
  let intradaySymbol = null;
  let hoverPts = []; // { ts, price, xf(0..1), yPix } for the current draw
  const CHART_H = 240;

  function windowStart(range) {
    if (range === 'YTD') return new Date(new Date().getFullYear(), 0, 1).getTime();
    const span = RANGE_MS[range] ?? Infinity;
    return span === Infinity ? -Infinity : Date.now() - span;
  }

  function drawChart() {
    const plot = $('#sp-chart-plot');
    // 1D uses real intraday minute bars fetched fresh from Yahoo (see
    // loadIntraday) instead of our own recorded history, which is only
    // dense enough for a smooth 1D view when a stock's actively in the
    // Finnhub hot set — intraday works the same for every symbol.
    const from = windowStart(chartRange);
    const pts = chartRange === '1D' ? (intradayPoints || []) : chartPoints.filter(([ts]) => ts >= from);
    if (pts.length < 2) {
      plot.innerHTML = '<div class="sp-chart-msg">Not enough history for this range yet.</div>';
      return;
    }
    const W = 1000;
    const H = 240;
    const pad = 8;
    let minP = Infinity;
    let maxP = -Infinity;
    for (const [, p] of pts) { if (p < minP) minP = p; if (p > maxP) maxP = p; }
    const t0 = pts[0][0];
    const t1 = pts[pts.length - 1][0];
    const spanT = t1 - t0 || 1;
    const spanP = maxP - minP || 1;
    const x = (ts) => ((ts - t0) / spanT) * W;
    const y = (p) => pad + (1 - (p - minP) / spanP) * (H - 2 * pad);
    let d = '';
    pts.forEach(([ts, p], i) => { d += (i ? 'L' : 'M') + x(ts).toFixed(1) + ' ' + y(p).toFixed(1); });
    // Store point coords for hover lookup (xf = 0..1 across width; yPix in the
    // 240px-tall plot, so % positioning maps 1:1 vertically).
    hoverPts = pts.map(([ts, p]) => ({ ts, price: p, xf: (ts - t0) / spanT, yPix: y(p) }));
    const up = pts[pts.length - 1][1] >= pts[0][1];
    const col = up ? 'var(--up)' : 'var(--down)';
    const area = `M0 ${H} ` + d.replace(/^M/, 'L') + ` L${W} ${H} Z`;
    const first = pts[0][1];
    const last = pts[pts.length - 1][1];
    const chg = last - first;
    const pct = first ? (chg / first) * 100 : 0;
    const sign = chg >= 0 ? '+' : '−';
    plot.innerHTML =
      `<div class="sp-chart-tip">${chartRange}: <b class="${up ? 'up' : 'down'}">${sign}${money(Math.abs(chg))} (${sign}${Math.abs(pct).toFixed(2)}%)</b></div>` +
      `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
      `<path class="sp-chart-area" d="${area}" fill="${col}"/>` +
      `<path class="sp-chart-line" d="${d}" stroke="${col}"/>` +
      `</svg>` +
      `<div class="sp-cross" hidden></div><div class="sp-dot" hidden></div><div class="sp-hoverbox" hidden></div>`;
  }

  // Hover crosshair + tooltip (like Yahoo). Attached once to the persistent
  // plot element; reads hoverPts from the latest draw.
  const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDateTime = (ts) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  function onHover(e) {
    const plot = $('#sp-chart-plot');
    const cross = plot.querySelector('.sp-cross');
    const dot = plot.querySelector('.sp-dot');
    const box = plot.querySelector('.sp-hoverbox');
    if (!hoverPts.length || !cross || !dot || !box) return;
    const rect = plot.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    let best = hoverPts[0];
    let bd = Infinity;
    for (const p of hoverPts) { const dd = Math.abs(p.xf - fx); if (dd < bd) { bd = dd; best = p; } }
    const left = best.xf * 100;
    cross.style.left = left + '%'; cross.hidden = false;
    dot.style.left = left + '%'; dot.style.top = best.yPix + 'px'; dot.hidden = false;
    box.innerHTML = `<b>${money(best.price)}</b><span>${(chartRange === '1D' || chartRange === '5D') ? fmtDateTime(best.ts) : fmtDate(best.ts)}</span>`;
    box.style.left = left + '%';
    // Keep the tooltip inside the plot near the edges.
    box.style.transform = best.xf < 0.12 ? 'translateX(0)' : best.xf > 0.88 ? 'translateX(-100%)' : 'translateX(-50%)';
    box.hidden = false;
  }
  function hideHover() {
    const plot = $('#sp-chart-plot');
    plot.querySelectorAll('.sp-cross, .sp-dot, .sp-hoverbox').forEach((el) => { el.hidden = true; });
  }
  (() => {
    const plot = $('#sp-chart-plot');
    if (plot) {
      plot.addEventListener('mousemove', onHover);
      plot.addEventListener('mouseleave', hideHover);
    }
  })();

  async function loadChart(sym) {
    chartPoints = [];
    intradayPoints = null; // new symbol — old symbol's intraday bars don't apply
    intradaySymbol = null;
    $('#sp-chart-plot').innerHTML = '<div class="sp-chart-msg">Loading chart…</div>';
    try {
      const r = await fetch('/api/history/' + encodeURIComponent(sym));
      const d = await r.json();
      if (current !== sym) return; // user moved on
      chartPoints = (d.points || []).sort((a, b) => a[0] - b[0]);
    } catch {}
    if (current === sym) {
      if (chartRange === '1D') await loadIntraday(sym);
      else drawChart();
    }
  }

  async function loadIntraday(sym) {
    if (intradaySymbol === sym && intradayPoints) return drawChart();
    $('#sp-chart-plot').innerHTML = '<div class="sp-chart-msg">Loading chart…</div>';
    try {
      const r = await fetch('/api/intraday/' + encodeURIComponent(sym));
      const d = await r.json();
      if (current !== sym) return;
      if (!r.ok) throw new Error(d.error || 'fetch failed');
      intradayPoints = (d.points || []).sort((a, b) => a[0] - b[0]);
      intradaySymbol = sym;
    } catch {
      intradayPoints = null; // drawChart's "not enough history" message covers this
    }
    if (current === sym) drawChart();
  }

  $('#sp-ranges').addEventListener('click', (e) => {
    const b = e.target.closest('.sp-range');
    if (!b) return;
    chartRange = b.dataset.range;
    [...$('#sp-ranges').children].forEach((c) => c.classList.toggle('active', c === b));
    if (chartRange === '1D') loadIntraday(current);
    else drawChart();
  });

  function close() {
    current = null;
    document.body.classList.remove('stock-open');
    page.hidden = true;
  }

  $('#sp-fav').addEventListener('click', () => {
    if (!current) return;
    if (favs.has(current)) favs.delete(current);
    else { favs.add(current); registerFavs([current]); }
    saveFavs();
    reflectFav(current);
  });
  // Re-register favourites now and every 60s so they rejoin Finnhub's hot set
  // after a server restart.
  registerFavs([...favs]);
  setInterval(() => registerFavs([...favs]), 60000);
  window.Favourites = {
    has: (s) => favs.has(s),
    list: () => [...favs],
    remove(sym) {
      favs.delete(sym);
      saveFavs();
      if (sym === current) reflectFav(sym);
    },
    // Toggle from anywhere (e.g. the search dropdown). Returns the new state.
    toggle(sym) {
      if (favs.has(sym)) favs.delete(sym);
      else { favs.add(sym); registerFavs([sym]); }
      saveFavs();
      if (sym === current) reflectFav(sym);
      return favs.has(sym);
    },
  };

  // history.back() (not a direct close()) so the browser's own Back button
  // and this in-page button stay in sync — see Nav/applyView in app.js.
  $('#sp-back').addEventListener('click', () => history.back());

  // Section nav: only Summary, Research & Projections, Financials, and
  // Analysis actually do anything yet (the rest are disabled placeholders).
  // Research & Projections shows the same "Earnings trends" section as
  // Analysis (same connector, same persisted/merged data — see
  // ensureAnalysisAndFinancials), just as its own standalone tab.
  document.querySelector('.sp-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.sp-nav-item[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('.sp-nav-item[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    $('#sp-tab-summary').hidden = tab !== 'summary';
    $('#sp-tab-research').hidden = tab !== 'research';
    $('#sp-tab-financials').hidden = tab !== 'financials';
    $('#sp-tab-analysis').hidden = tab !== 'analysis';
    if (tab === 'financials') loadFinancials();
    if (tab === 'analysis') loadAnalysis();
    if (tab === 'research') loadResearch();
  });

  // ── Financials tab ───────────────────────────────────────────────────────
  // Income statement / balance sheet / cash flow, annual or quarterly — all
  // three statements + both periods come back in one /api/financials call
  // (see server/yahoo-financials.js), so switching the toggle buttons below
  // just re-renders from what's already fetched, no extra network call.
  let finData = null;
  let finSymbol = null;
  let finStatement = 'income';
  let finPeriod = 'annual';

  function fmtFinNum(n) {
    if (n == null) return '—';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(2) + 'K';
    return sign + abs.toFixed(2);
  }

  async function loadFinancials() {
    const wrap = $('#fin-table-wrap');
    if (finSymbol === current && finData) return renderFinTable();
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const r = await fetch('/api/financials/' + encodeURIComponent(current));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'fetch failed');
      finData = d.financials;
      finSymbol = current;
      renderFinTable();
    } catch (e) {
      wrap.innerHTML = `<p class="muted">Could not load financials for ${esc(current)}${e.message ? ' — ' + esc(e.message) : ''}.</p>`;
    }
  }

  function renderFinTable() {
    const wrap = $('#fin-table-wrap');
    const table = finData && finData[finStatement] && finData[finStatement][finPeriod];
    if (!table || !table.rows.length) {
      wrap.innerHTML = '<p class="muted">No data available for this statement/period.</p>';
      return;
    }
    // Newest period first, matching how Yahoo's own financials page reads.
    const order = table.dates.map((_, i) => i).reverse();
    const quarterOf = (i) => (table.quarters && table.quarters[i]) || '';
    const head = '<th>Breakdown</th>' + order.map((i) => `<th>${esc(quarterOf(i))}<br><span class="fin-date">${esc(table.dates[i])}</span></th>`).join('');
    const rows = table.rows
      .map((r) => `<tr><td>${esc(r.label)}</td>${order.map((i) => `<td title="${r.values[i] != null ? r.values[i].toLocaleString() : ''}">${fmtFinNum(r.values[i])}</td>`).join('')}</tr>`)
      .join('');
    wrap.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  $('#fin-statements').addEventListener('click', (e) => {
    const btn = e.target.closest('.fin-tab[data-statement]');
    if (!btn) return;
    finStatement = btn.dataset.statement;
    $('#fin-statements').querySelectorAll('.fin-tab').forEach((b) => b.classList.toggle('active', b === btn));
    renderFinTable();
  });
  $('#fin-periods').addEventListener('click', (e) => {
    const btn = e.target.closest('.fin-tab[data-period]');
    if (!btn) return;
    finPeriod = btn.dataset.period;
    $('#fin-periods').querySelectorAll('.fin-tab').forEach((b) => b.classList.toggle('active', b === btn));
    renderFinTable();
  });
  // ── Analysis tab ─────────────────────────────────────────────────────────
  // Analyst price targets, recommendation trend, earnings/revenue estimates,
  // earnings history — same connector as Financials (/api/analysis, see
  // server/yahoo-financials.js's getAnalysis), same lazy-load-once-per-symbol
  // pattern as loadFinancials above.
  let anData = null;
  let anSymbol = null;
  let anChartPeriod = 'quarterly'; // toggle for both charts below

  // Per-dot/per-bar hover tooltip for the EPS/Revenue-vs-earnings charts —
  // attached once to each tab's stable container (not re-attached on every
  // re-render, since the content div's innerHTML gets replaced each time).
  // Shows only while the cursor is directly over an element with data-tip,
  // gone the instant it isn't — unlike the price chart's crosshair, these
  // are discrete points/bars, not a continuous line, so there's nothing to
  // interpolate between. Both the Analysis tab and the Research &
  // Projections tab show these same charts, so both need their own
  // instance of this (separate host/tip elements, same behavior).
  function setupChartHoverTip(hostSelector, tipSelector) {
    const host = $(hostSelector);
    const tip = $(tipSelector);
    if (!host || !tip) return;
    host.addEventListener('mousemove', (e) => {
      const el = e.target.closest('circle[data-tip], rect[data-tip]');
      if (!el) { tip.hidden = true; return; }
      const hostRect = host.getBoundingClientRect();
      tip.innerHTML = `<b>${esc(el.dataset.tip)}</b>`;
      tip.style.left = e.clientX - hostRect.left + 'px';
      tip.style.top = e.clientY - hostRect.top + 'px';
      tip.hidden = false;
    });
    host.addEventListener('mouseleave', () => { tip.hidden = true; });
  }
  setupChartHoverTip('#sp-tab-analysis', '#an-tip');
  setupChartHoverTip('#sp-tab-research', '#rp-tip');

  function fmtEps(n) { return n == null ? '—' : (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2); }
  function fmtPct2(n) { return n == null ? '—' : (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%'; }
  const RECS = { strong_buy: 'Strong Buy', buy: 'Buy', hold: 'Hold', sell: 'Sell', strong_sell: 'Strong Sell', none: '—' };

  // Shared by the Analysis tab and the Research & Projections tab — both
  // show the same "Earnings trends" section from the exact same connector,
  // so they share the same anData/finData cache rather than each fetching
  // (and persisting/merging) their own separate copy. Throws on failure;
  // callers render their own error state.
  async function ensureAnalysisAndFinancials() {
    if (anSymbol === current && anData && finSymbol === current) return;
    const needAn = anSymbol !== current;
    const needFin = finSymbol !== current;
    const [anRes, finRes] = await Promise.all([
      needAn ? fetch('/api/analysis/' + encodeURIComponent(current)) : Promise.resolve(null),
      needFin ? fetch('/api/financials/' + encodeURIComponent(current)) : Promise.resolve(null),
    ]);
    if (anRes) {
      const anBody = await anRes.json();
      if (!anRes.ok) throw new Error(anBody.error || 'fetch failed');
      anData = anBody.analysis;
      anSymbol = current;
    }
    if (finRes) {
      const finBody = await finRes.json();
      if (finRes.ok) { finData = finBody.financials; finSymbol = current; }
    }
  }

  async function loadAnalysis() {
    const wrap = $('#an-content');
    if (anSymbol === current && anData) return renderAnalysis();
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
      await ensureAnalysisAndFinancials();
      renderAnalysis();
    } catch (e) {
      wrap.innerHTML = `<p class="muted">Could not load analysis for ${esc(current)}${e.message ? ' — ' + esc(e.message) : ''}.</p>`;
    }
  }

  let rpChartPeriod = 'quarterly';
  async function loadResearch() {
    const wrap = $('#rp-content');
    if (anSymbol === current && anData) return renderResearchTab();
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
      await ensureAnalysisAndFinancials();
      renderResearchTab();
    } catch (e) {
      wrap.innerHTML = `<p class="muted">Could not load projections for ${esc(current)}${e.message ? ' — ' + esc(e.message) : ''}.</p>`;
    }
  }
  function renderResearchTab() {
    const wrap = $('#rp-content');
    if (!anData) { wrap.innerHTML = '<p class="muted">No projections data available.</p>'; return; }
    const revenuePeriods = rpChartPeriod === 'annual' ? ['0y', '+1y'] : ['0q', '+1q'];
    wrap.innerHTML = earningsTrendsHtml('rp', rpChartPeriod) + allTablesHtml('Revenue & Projections', revenuePeriods, rpChartPeriod);
    wireEarningsTrendsToggle('rp', () => rpChartPeriod, (v) => { rpChartPeriod = v; }, renderResearchTab);
    // Fires on blur/Enter (not every keystroke), so re-rendering the whole
    // table on change doesn't fight you mid-type.
    wrap.querySelectorAll('.rev-custom-input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const inputs = getCustomRevenue(current, rpChartPeriod);
        inputs[inp.dataset.field][Number(inp.dataset.idx)] = inp.value === '' ? null : Number(inp.value) * Number(inp.dataset.scale || 1);
        saveCustomRevenue(current, rpChartPeriod, inputs);
        renderResearchTab();
      });
    });
  }

  // Quarterly: real reported quarters, actual vs. that quarter's own estimate
  // (earningsHistory module — genuine beat/miss history).
  function quarterlyEpsPoints() {
    let pts = [...(anData.earningsHistory || [])].filter((h) => h.epsActual != null || h.epsEstimate != null);
    pts.sort((a, b) => (a.quarter || '').localeCompare(b.quarter || ''));
    pts = pts.slice(-20); // up to 5 years (20 quarters) of real history — earningsHistory accumulates over repeat visits (see mergeByKey), so cap it rather than let the chart keep growing indefinitely
    // Append the current/next unreported quarter's forward estimate (no
    // actual yet) — same "projection tacked onto the real history" idea
    // Yahoo's own chart uses (its future column shows only an open circle).
    for (const e of anData.earningsEstimate || []) {
      if (e.period.endsWith('q') && e.endDate && !pts.some((p) => p.quarter === e.endDate)) {
        pts.push({ quarter: e.endDate, epsActual: null, epsEstimate: e.epsEstimate });
      }
    }
    return pts.sort((a, b) => (a.quarter || '').localeCompare(b.quarter || ''));
  }
  // Annual: Yahoo has no "annual earnings history" module (beat/miss is
  // inherently a quarterly concept), so this combines what does exist —
  // actual annual EPS from the Financials connector's income statement, plus
  // the current/next fiscal year's forward estimate (earningsTrend's '0y'/
  // '+1y' periods) as estimate-only points. Past years show no estimate dot
  // since there's no historical annual consensus to compare against.
  function annualEpsPoints() {
    let actual = [];
    const annual = finData && finData.income && finData.income.annual;
    if (annual) {
      const epsRow = annual.rows.find((r) => r.key === 'DilutedEPS') || annual.rows.find((r) => r.key === 'BasicEPS');
      if (epsRow) annual.dates.forEach((d, i) => { if (epsRow.values[i] != null) actual.push({ quarter: d.slice(0, 4), epsActual: epsRow.values[i], epsEstimate: null }); });
    }
    actual = actual.slice(-5); // up to 5 years of real history — annual.dates accumulates over repeat visits (see mergeTable), so cap it rather than let the chart keep growing
    const pts = [...actual];
    for (const e of anData.earningsEstimate || []) {
      if (e.period.endsWith('y')) pts.push({ quarter: (e.endDate || '').slice(0, 4), epsActual: null, epsEstimate: e.epsEstimate });
    }
    return pts;
  }

  // EPS actual-vs-estimate dot chart, Yahoo-Finance-style: green dot = beat,
  // red = missed, open circle = estimate, dashed line connecting estimates.
  function renderEpsChart(pts) {
    if (!pts.length) return '<p class="muted">No earnings history available.</p>';
    const W = 640, H = 220, PAD_L = 46, PAD_B = 34, PAD_T = 14, PAD_R = 16;
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    const vals = pts.flatMap((p) => [p.epsActual, p.epsEstimate]).filter((v) => v != null);
    const lo = Math.min(0, ...vals), hi = Math.max(...vals) * 1.15 || 1;
    const y = (v) => PAD_T + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
    const x = (i) => PAD_L + (pts.length > 1 ? (i / (pts.length - 1)) * plotW : plotW / 2);
    const GRID = 4;
    const gridLines = Array.from({ length: GRID + 1 }, (_, i) => {
      const v = lo + ((hi - lo) * i) / GRID;
      const gy = y(v);
      return `<line x1="${PAD_L}" y1="${gy.toFixed(1)}" x2="${W - PAD_R}" y2="${gy.toFixed(1)}" class="an-grid"/><text x="${PAD_L - 8}" y="${(gy + 4).toFixed(1)}" class="an-axis" text-anchor="end">${v.toFixed(2)}</text>`;
    }).join('');
    const dots = pts
      .map((p, i) => {
        const cx = x(i).toFixed(1);
        const bits = [];
        if (p.epsEstimate != null) bits.push(`<circle cx="${cx}" cy="${y(p.epsEstimate).toFixed(1)}" r="6" class="an-dot-est" data-tip="${esc(p.quarter || '')} — Estimate ${esc(fmtEps(p.epsEstimate))}"/>`);
        if (p.epsActual != null) {
          // No estimate to compare against (annual actuals) -> a neutral dot,
          // not a defaulted beat/miss color — same bug as the label below,
          // just the opposite direction (this one defaulted to "beat").
          const dotCls = p.epsEstimate == null ? 'an-dot-neutral' : p.epsActual >= p.epsEstimate ? 'an-dot-beat' : 'an-dot-miss';
          const delta = p.epsEstimate != null ? p.epsActual - p.epsEstimate : null;
          const tip = `${esc(p.quarter || '')} — Actual ${esc(fmtEps(p.epsActual))}` + (delta != null ? ` (${delta >= 0 ? '+' : ''}${esc(fmtEps(delta))} vs est.)` : '');
          bits.push(`<circle cx="${cx}" cy="${y(p.epsActual).toFixed(1)}" r="7" class="${dotCls}" data-tip="${tip}"/>`);
        }
        return bits.join('');
      })
      .join('');
    const labels = pts
      .map((p, i) => {
        // Three distinct cases, not two: a future point (estimate only, no
        // actual yet), a real beat/miss (both actual and estimate present —
        // quarterly only, since Yahoo has no annual estimate history to
        // compare against), or an annual actual with nothing to compare to
        // at all. That last case used to fall through to "Missed" — `beat`
        // was `null` (no comparison available) and `null` is falsy, so it
        // read as a miss even though there was no estimate in the first
        // place. Handle it as its own case instead of guessing.
        let label, cls;
        if (p.epsActual == null) {
          label = 'Estimate ' + fmtEps(p.epsEstimate);
          cls = 'an-axis';
        } else if (p.epsEstimate == null) {
          label = 'Actual ' + fmtEps(p.epsActual);
          cls = 'an-axis';
        } else {
          const beat = p.epsActual >= p.epsEstimate;
          const delta = p.epsActual - p.epsEstimate;
          label = (beat ? 'Beat ' : 'Missed ') + (delta >= 0 ? '+' : '') + fmtEps(delta);
          cls = beat ? 'an-beat-txt' : 'an-miss-txt';
        }
        return `<text x="${x(i).toFixed(1)}" y="${H - 6}" class="an-axis" text-anchor="middle">${esc(p.quarter || '')}</text>
                <text x="${x(i).toFixed(1)}" y="${H - 20}" class="${cls}" text-anchor="middle" font-size="10">${esc(label)}</text>`;
      })
      .join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="an-chart-svg">${gridLines}${dots}${labels}</svg>`;
  }

  // Generic grouped-bar SVG: Revenue vs. Net income per column, with any
  // "not a reported figure" columns (projLabel identifies which) rendered
  // lighter/dashed. Shared by the Analysis tab's chart (analyst-estimate
  // projected columns) and the Research tab's chart (your own custom-input
  // columns) — same visual language, different source for what's projected.
  function renderBarsSvg(dates, rev, ni, projected, projLabel) {
    const n = dates.length;
    const W = 640, H = 220, PAD_L = 50, PAD_B = 34, PAD_T = 14, PAD_R = 16;
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    const max = Math.max(...rev.filter((v) => v != null), ...ni.filter((v) => v != null), 1);
    const y = (v) => PAD_T + plotH - ((v || 0) / max) * plotH;
    const groupW = plotW / n;
    const barW = groupW * 0.28;
    const bars = dates
      .map((d, i) => {
        const gx = PAD_L + groupW * i + groupW / 2;
        const rv = rev[i], nv = ni[i];
        const rH = plotH - (y(rv) - PAD_T), nH = nv != null ? plotH - (y(nv) - PAD_T) : 0;
        const isProj = projected[i];
        const revClass = 'an-bar-rev' + (isProj ? ' an-bar-proj' : '');
        const niClass = 'an-bar-ni' + (isProj ? ' an-bar-proj' : '');
        const suffix = isProj ? ` (${projLabel})` : '';
        return `<rect x="${(gx - barW - 2).toFixed(1)}" y="${y(rv).toFixed(1)}" width="${barW.toFixed(1)}" height="${rH.toFixed(1)}" class="${revClass}" data-tip="${esc(d)} — Revenue${suffix} ${esc(fmtFinNum(rv))}"/>
                <rect x="${(gx + 2).toFixed(1)}" y="${(nv != null ? y(nv) : PAD_T + plotH).toFixed(1)}" width="${barW.toFixed(1)}" height="${nH.toFixed(1)}" class="${niClass}" data-tip="${esc(d)} — Net income${suffix} ${esc(fmtFinNum(nv))}"/>
                <text x="${gx.toFixed(1)}" y="${H - 6}" class="an-axis" text-anchor="middle">${esc(d)}${isProj ? ` (${projLabel})` : ''}</text>`;
      })
      .join('');
    const legendLabel = projLabel === 'est.' ? 'Projected' : 'Your input';
    return `<div class="an-bar-legend"><span class="an-leg-sw an-bar-rev"></span>Revenue <span class="an-leg-sw an-bar-ni"></span>Net income <span class="an-leg-sw an-bar-proj-sw"></span>${esc(legendLabel)}</div>
      <svg viewBox="0 0 ${W} ${H}" class="an-chart-svg">${bars}</svg>`;
  }

  // Analysis tab only: actual quarterly/annual Total Revenue vs Net Income
  // (Financials connector), plus one forward projected period tacked on the
  // end — Revenue from the matching earningsEstimate period, Net income
  // approximated as epsEstimate × the most recent actual diluted share
  // count (Yahoo doesn't give a direct total-$ earnings estimate, only
  // per-share — this is the same approximation analysts imply when they
  // don't separately forecast share count). The Research tab's version of
  // this chart (renderResearchRevenueEarningsChart, below) deliberately does
  // NOT use analyst estimates — it's linked to the Revenue & Projections
  // table's own data (real history + your custom input columns) instead.
  function renderRevenueEarningsChart(finTable, period) {
    if (!finTable || !finTable.dates || !finTable.dates.length) return '<p class="muted">No financials data available.</p>';
    const revRow = finTable.rows.find((r) => r.key === 'TotalRevenue');
    const niRow = finTable.rows.find((r) => r.key === 'NetIncomeCommonStockholders');
    const sharesRow = finTable.rows.find((r) => r.key === 'DilutedAverageShares');
    if (!revRow) return '<p class="muted">No revenue data available.</p>';
    const histCap = period === 'annual' ? 5 : 20; // 5 years annual, or 5 years' worth of quarters
    const histN = Math.min(histCap, finTable.dates.length); // up to histCap periods of real history, plus whatever projections get appended below
    const startIdx = finTable.dates.length - histN;
    const dates = finTable.dates.slice(startIdx);
    const rev = revRow.values.slice(startIdx);
    const ni = (niRow ? niRow.values : dates.map(() => null)).slice(startIdx);
    const projected = dates.map(() => false);

    // Every forward period Yahoo actually gives us for this granularity
    // (currently 0q/+1q or 0y/+1y — but written to include however many
    // there are, not just the first, in case that ever changes), oldest
    // projected period first.
    const periodSuffix = period === 'annual' ? 'y' : 'q';
    const estimates = (anData.earningsEstimate || [])
      .filter((e) => e.period.endsWith(periodSuffix) && e.endDate && !dates.includes(e.endDate))
      .sort((a, b) => (a.endDate || '').localeCompare(b.endDate || ''));
    let latestShares = sharesRow ? [...sharesRow.values].reverse().find((v) => v != null) : null;
    // Yahoo doesn't always report DilutedAverageShares directly (e.g. AAPL's
    // quarterly data has none at all) — fall back to implying it from the
    // most recent actual quarter we do have both figures for: shares =
    // net income ÷ diluted EPS, algebraically the same number.
    if (latestShares == null) {
      const epsRow = finTable.rows.find((r) => r.key === 'DilutedEPS');
      if (epsRow && niRow) {
        for (let i = finTable.dates.length - 1; i >= 0; i--) {
          if (epsRow.values[i] && niRow.values[i] != null) { latestShares = niRow.values[i] / epsRow.values[i]; break; }
        }
      }
    }
    for (const est of estimates) {
      dates.push(est.endDate);
      rev.push(est.revenueEstimate ?? null);
      ni.push(est.epsEstimate != null && latestShares ? est.epsEstimate * latestShares : null);
      projected.push(true);
    }

    return renderBarsSvg(dates, rev, ni, projected, 'est.');
  }

  // Research tab only: linked to the Revenue & Projections table's own data
  // (buildRevenueProjectionData) — real reported history + your custom
  // input columns, never analyst estimates. Same bar-SVG renderer as the
  // Analysis tab's chart, just fed from a different, deliberately separate
  // source, and this one's earnings-derived Net income figures are estimated
  // for custom columns the same way (EPS × latest known shares) — except
  // there's no EPS input here, only revenue, so custom columns' Net income
  // bars are simply blank until you've entered enough for Margin to compute
  // — see buildRevenueProjectionData for exactly what is/isn't available per column.
  function renderResearchRevenueEarningsChart(period) {
    const { cols, revValues, earningsValues } = buildRevenueProjectionData(period);
    if (!cols.length) return '<p class="muted">No financials data available.</p>';
    const dates = cols.map((c) => c.label);
    const projected = cols.map((c) => c.custom);
    return renderBarsSvg(dates, revValues, earningsValues, projected, 'your input');
  }

  // Price targets as a plain text line under the "Earnings trends" title —
  // shared by the Analysis tab and the Research & Projections tab, since
  // both show this same section from the same connector (see below).
  function buildTargetsLine() {
    const pt = (anData && anData.priceTargets) || {};
    return `<p class="an-targets-line">Price target: <span class="an-pt-num">${pt.low != null ? fmtEps(pt.low) : '—'}</span> low · <span class="an-pt-num an-pt-mean">${pt.mean != null ? fmtEps(pt.mean) : '—'}</span> mean · <span class="an-pt-num">${pt.high != null ? fmtEps(pt.high) : '—'}</span> high — ${pt.numberOfAnalysts || 0} analysts · Recommendation: <strong>${esc(RECS[pt.recommendationKey] || pt.recommendationKey || '—')}</strong></p>`;
  }

  // The "Earnings trends" section (price targets line + EPS chart + revenue-
  // vs-earnings chart + Annual/Quarterly toggle) — used identically by both
  // the Analysis tab and the Research & Projections tab. Both pull from the
  // exact same anData/finData (same connector, same persisted/merged data on
  // disk — see server/yahoo-financials.js); idPrefix just keeps their two
  // toggle buttons' DOM ids from colliding since both panes can exist at once.
  function earningsTrendsHtml(idPrefix, period) {
    const epsPts = period === 'annual' ? annualEpsPoints() : quarterlyEpsPoints();
    // Research tab's chart is linked to the Revenue & Projections table
    // (real history + your custom columns, no analyst estimates); the
    // Analysis tab's chart keeps using analyst-estimate projections —
    // deliberately different sources, per idPrefix.
    const revChartHtml = idPrefix === 'rp'
      ? renderResearchRevenueEarningsChart(period)
      : renderRevenueEarningsChart(finData && finData.income && finData.income[period], period);
    return `<div class="an-charts-head">
      <div>
        <h2 class="an-charts-title">Earnings trends</h2>
        ${buildTargetsLine()}
      </div>
      <div class="fin-periods" id="${idPrefix}-period">
        <button class="fin-tab${period === 'annual' ? ' active' : ''}" data-period="annual">Annual</button>
        <button class="fin-tab${period === 'quarterly' ? ' active' : ''}" data-period="quarterly">Quarterly</button>
      </div>
    </div>
    <div class="an-charts-row">
      <div class="an-chart-card card">
        <h3>Earnings per share</h3>
        ${renderEpsChart(epsPts)}
      </div>
      <div class="an-chart-card card">
        <h3>Revenue vs. earnings</h3>
        ${revChartHtml}
      </div>
    </div>`;
  }
  function wireEarningsTrendsToggle(idPrefix, getPeriod, setPeriod, rerender) {
    $(`#${idPrefix}-period`).addEventListener('click', (e) => {
      const btn = e.target.closest('.fin-tab[data-period]');
      if (!btn) return;
      setPeriod(btn.dataset.period);
      rerender();
    });
  }

  // Raw period codes are like "0m"/"-1m"/"-2m"/"-3m" — humanize to "Current
  // month"/"1 month ago" etc. rather than showing the code verbatim.
  function monthPeriodLabel(period) {
    if (period === '0m') return 'Current month';
    const m = parseInt(period, 10);
    if (!isNaN(m)) return Math.abs(m) + (Math.abs(m) === 1 ? ' month ago' : ' months ago');
    return period;
  }
  function recommendationTrendHtml() {
    const recRows = (anData.recommendationTrend || [])
      .map((t) => `<tr><td>${esc(monthPeriodLabel(t.period))}</td><td class="num">${t.strongBuy ?? '—'}</td><td class="num">${t.buy ?? '—'}</td><td class="num">${t.hold ?? '—'}</td><td class="num">${t.sell ?? '—'}</td><td class="num">${t.strongSell ?? '—'}</td></tr>`)
      .join('');
    return `<div class="table-wrap an-section">
      <h3>Recommendation trend</h3>
      <div class="table-scroll"><table><thead><tr><th>Period</th><th class="num">Strong Buy</th><th class="num">Buy</th><th class="num">Hold</th><th class="num">Sell</th><th class="num">Strong Sell</th></tr></thead>
      <tbody>${recRows || '<tr><td colspan="6" class="muted">No data.</td></tr>'}</tbody></table></div>
    </div>`;
  }

  // Revenue estimate / Earnings estimate: Yahoo shows these as two separate
  // tables, periods as columns (Current qtr/Next qtr/Current year/Next
  // year), metrics as rows — transposed from how we store it (one entry
  // per period with all its fields). Same underlying anData.earningsEstimate,
  // just laid out to match.
  const PERIOD_LABELS = { '0q': 'Current qtr.', '+1q': 'Next qtr.', '0y': 'Current year', '+1y': 'Next year' };
  const PERIODS = ['0q', '+1q', '0y', '+1y'];
  const monthYear = (d) => { const dt = new Date(d); return isNaN(dt) ? '' : dt.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }); };
  function estimateTableHtml(title, rowsDef, periods = PERIODS) {
    const periodEntry = (p) => (anData.earningsEstimate || []).find((e) => e.period === p);
    const entries = periods.map(periodEntry);
    if (!entries.some(Boolean)) return '';
    const headCells = periods.map((p, i) => `<th class="num">${PERIOD_LABELS[p]}${entries[i]?.endDate ? ` (${monthYear(entries[i].endDate)})` : ''}</th>`).join('');
    const bodyRows = rowsDef
      .map(({ label, get }) => `<tr><td>${esc(label)}</td>${entries.map((e) => `<td class="num">${e ? get(e) : '—'}</td>`).join('')}</tr>`)
      .join('');
    return `<div class="table-wrap an-section"><h3>${esc(title)}</h3><div class="table-scroll"><table><thead><tr><th>Currency in USD</th>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div></div>`;
  }
  // Research tab's "Revenue & Projections" table: up to 5 years of real
  // actual revenue (Financials connector) — 5 annual periods, or 20
  // quarterly ones (still 5 years, just quarterly resolution) — followed by
  // whichever forward period(s) apply (0y/+1y or 0q/+1q). A mix the generic
  // estimateTableHtml can't do (it only ever has estimate-period columns, no
  // plain historical actuals), so this builds its own column set instead.
  // Your own manually-typed Revenue and Earnings guesses for the 3 extra
  // blank columns in revenueProjectionsHtml below — kept in localStorage
  // (not the server), since these are personal what-if numbers, not pulled
  // data. Keyed by symbol + period so annual and quarterly inputs don't
  // overwrite each other. Change/Change %/Margin stay computed automatically
  // from whichever of these two you've typed in — they're derived, not
  // separately-editable, so they can't silently disagree with Revenue/Earnings.
  const CUSTOM_REV_KEY = 'cashmoney.customRevenue';
  function getCustomRevenue(sym, period) {
    try {
      const all = JSON.parse(localStorage.getItem(CUSTOM_REV_KEY)) || {};
      const v = (all[sym] && all[sym][period]) || {};
      return { revenue: v.revenue || [null, null, null], earnings: v.earnings || [null, null, null] };
    } catch {
      return { revenue: [null, null, null], earnings: [null, null, null] };
    }
  }
  function saveCustomRevenue(sym, period, inputs) {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(CUSTOM_REV_KEY)) || {}; } catch {}
    if (!all[sym]) all[sym] = {};
    all[sym][period] = inputs;
    localStorage.setItem(CUSTOM_REV_KEY, JSON.stringify(all));
  }

  // Real reported periods (5 years annual, or 5 years' worth of quarters) +
  // 3 blank user-input columns past them — analyst forward estimates
  // deliberately excluded. Shared by the Revenue & Projections table AND
  // the Research tab's Revenue-vs-earnings chart, so they're always showing
  // the exact same numbers — "linked", not two separate computations that
  // could drift apart.
  function buildRevenueProjectionData(period) {
    const finTable = finData && finData.income && finData.income[period];
    const revRow = finTable && finTable.rows.find((r) => r.key === 'TotalRevenue');
    const niRow = finTable && finTable.rows.find((r) => r.key === 'NetIncomeCommonStockholders');
    const histCap = period === 'annual' ? 5 : 20;
    const histDates = (finTable ? finTable.dates : []).slice(-histCap);
    const histValues = revRow ? revRow.values.slice(-histDates.length) : [];
    const histNiValues = niRow ? niRow.values.slice(-histDates.length) : [];
    const labelOf = (d) => (period === 'annual' ? (d || '').slice(0, 4) : d || '');
    const cols = histDates.map((d, i) => ({ label: labelOf(d), actual: histValues[i], custom: false }));
    if (!cols.length) return { cols: [], revValues: [], earningsValues: [], customInputs: getCustomRevenue(current, period) };
    // 3 extra blank columns past the real data — one more year (or quarter)
    // at a time — for your own manual "what if" Revenue and Earnings
    // numbers. Persisted in localStorage (not the server) since these are
    // your own guesses, not pulled data, keyed per symbol + period so
    // annual/quarterly don't clash.
    const customInputs = getCustomRevenue(current, period);
    for (let i = 0; i < 3; i++) {
      const lastLabel = cols[cols.length - 1].label;
      let label;
      if (period === 'annual') {
        const y = parseInt(lastLabel, 10);
        label = isNaN(y) ? '' : String(y + 1);
      } else {
        const dt = new Date(lastLabel);
        if (!isNaN(dt)) dt.setUTCMonth(dt.getUTCMonth() + 3);
        label = isNaN(dt) ? '' : dt.toISOString().slice(0, 10);
      }
      cols.push({ label, actual: null, custom: true, customIndex: i });
    }
    // One plain revenue/earnings number per column (actual or your custom
    // input) so Change/Change %/Margin can compare consecutive columns —
    // including the transition from the last actual period into your first
    // custom one.
    const numOrNull = (v) => (v != null && v !== '' ? Number(v) : null);
    const revValues = cols.map((c) => (c.custom ? numOrNull(customInputs.revenue[c.customIndex]) : c.actual));
    const earningsValues = cols.map((c, i) => (c.custom ? numOrNull(customInputs.earnings[c.customIndex]) : histNiValues[i]));
    // Type "35" instead of "35000000000" — the input's unit matches whatever
    // scale the most recent actual figure is already in (B/M/K), same
    // thresholds fmtFinNum uses for display. Values are still stored raw
    // (unscaled) everywhere else; only the input's shown/typed number is
    // scaled, converted back to raw the moment it's saved.
    const lastActualRev = [...histValues].reverse().find((v) => v != null);
    const lastActualEarn = [...histNiValues].reverse().find((v) => v != null);
    const revUnit = unitScale(lastActualRev);
    const earnUnit = unitScale(lastActualEarn);
    // For the P/E ratio row: today's price × most recent diluted share count
    // = today's implied market cap, divided by each column's earnings (actual
    // or your custom input) — same "current price against whatever period's
    // earnings" idea, since we don't have a historical price per period to
    // pair each year with its own market cap.
    const sharesRow = finTable && finTable.rows.find((r) => r.key === 'DilutedAverageShares');
    let latestShares = sharesRow ? [...sharesRow.values].reverse().find((v) => v != null) : null;
    if (latestShares == null && finTable) {
      const epsRow = finTable.rows.find((r) => r.key === 'DilutedEPS');
      if (epsRow && niRow) {
        for (let i = finTable.dates.length - 1; i >= 0; i--) {
          if (epsRow.values[i] && niRow.values[i] != null) { latestShares = niRow.values[i] / epsRow.values[i]; break; }
        }
      }
    }
    const marketCap = lastPrice && latestShares ? Number(lastPrice) * latestShares : null;
    return { cols, revValues, earningsValues, customInputs, revUnit, earnUnit, marketCap };
  }
  function unitScale(n) {
    if (n == null) return { scale: 1, suffix: '' };
    const abs = Math.abs(n);
    if (abs >= 1e9) return { scale: 1e9, suffix: 'B' };
    if (abs >= 1e6) return { scale: 1e6, suffix: 'M' };
    if (abs >= 1e3) return { scale: 1e3, suffix: 'K' };
    return { scale: 1, suffix: '' };
  }

  function revenueProjectionsHtml(title, period) {
    const { cols, revValues, earningsValues, customInputs, revUnit, earnUnit, marketCap } = buildRevenueProjectionData(period);
    if (!cols.length) return '';
    const scaledInput = (raw, unit, field, idx) => {
      const shown = raw != null ? raw / unit.scale : '';
      return `<span class="rev-input-wrap"><input type="number" class="rev-custom-input" data-field="${field}" data-idx="${idx}" data-scale="${unit.scale}" value="${shown}" placeholder="—">${unit.suffix ? `<span class="rev-input-unit">${unit.suffix}</span>` : ''}</span>`;
    };
    const headCells = cols.map((c) => `<th class="num">${esc(c.label)}${c.custom ? ' (your input)' : ''}</th>`).join('');
    const rowsDef = [
      {
        label: 'Revenue',
        get: (c) => (c.custom ? scaledInput(customInputs.revenue[c.customIndex], revUnit, 'revenue', c.customIndex) : fmtFinNum(c.actual)),
      },
      {
        label: 'Change',
        get: (c, i) => {
          if (i === 0 || revValues[i] == null || revValues[i - 1] == null) return '—';
          const d = revValues[i] - revValues[i - 1];
          return (d >= 0 ? '+' : '') + fmtFinNum(d);
        },
      },
      {
        label: 'Change %',
        get: (c, i) => {
          if (i === 0 || revValues[i] == null || !revValues[i - 1]) return '—';
          return fmtPct2((revValues[i] - revValues[i - 1]) / revValues[i - 1]);
        },
      },
      {
        label: 'Margin',
        get: (c, i) => {
          const e = earningsValues[i];
          if (e == null || !revValues[i]) return '—';
          return fmtPct2(e / revValues[i]);
        },
      },
      {
        label: 'Earnings',
        get: (c, i) => {
          if (c.custom) return scaledInput(customInputs.earnings[c.customIndex], earnUnit, 'earnings', c.customIndex);
          return fmtFinNum(earningsValues[i]);
        },
      },
      {
        label: 'P/E ratio',
        get: (c, i) => {
          const e = earningsValues[i];
          if (marketCap == null || !e) return '—';
          return (marketCap / e).toFixed(1);
        },
      },
    ];
    const bodyRows = rowsDef.map(({ label, get }) => `<tr><td>${esc(label)}</td>${cols.map((c, i) => `<td class="num">${get(c, i)}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap an-section"><h3>${esc(title)}</h3><div class="table-scroll"><table><thead><tr><th>Currency in USD</th>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div></div>`;
  }
  // revenuePeriods lets the Research & Projections tab's "Revenue &
  // Projections" table follow its Annual/Quarterly toggle (just 2 columns
  // instead of all 4) — Earnings estimate and the Analysis tab both keep
  // showing all 4 periods, unaffected. historyPeriod ('annual'/'quarterly')
  // switches the revenue table to revenueProjectionsHtml (5 years of real
  // history, annual or quarterly resolution, + the projected periods)
  // instead of just the two projected columns.
  function estimateTablesHtml(revenueTitle = 'Revenue estimate', revenuePeriods = PERIODS, historyPeriod = null) {
    const revenueEstHtml = historyPeriod
      ? revenueProjectionsHtml(revenueTitle, historyPeriod)
      : estimateTableHtml(revenueTitle, [
      { label: 'No. of analysts', get: (e) => e.numberOfAnalysts ?? '—' },
      { label: 'Avg. Estimate', get: (e) => fmtFinNum(e.revenueEstimate) },
      { label: 'Low estimate', get: (e) => fmtFinNum(e.revenueLow) },
      { label: 'High estimate', get: (e) => fmtFinNum(e.revenueHigh) },
      { label: 'Year ago sales', get: (e) => fmtFinNum(e.revenueYearAgo) },
      { label: 'Sales growth (year/est)', get: (e) => fmtPct2(e.revenueGrowth) },
    ], revenuePeriods);
    const earningsEstHtml = estimateTableHtml('Earnings estimate', [
      { label: 'No. of analysts', get: (e) => e.epsNumberOfAnalysts ?? '—' },
      { label: 'Avg. Estimate', get: (e) => fmtEps(e.epsEstimate) },
      { label: 'Low estimate', get: (e) => fmtEps(e.epsLow) },
      { label: 'High estimate', get: (e) => fmtEps(e.epsHigh) },
      { label: 'Year ago EPS', get: (e) => fmtEps(e.epsYearAgo) },
      { label: 'EPS growth (year/est)', get: (e) => fmtPct2(e.epsGrowth) },
    ]);
    return revenueEstHtml + earningsEstHtml;
  }
  function earningsHistoryHtml() {
    const histRows = (anData.earningsHistory || [])
      .map((h) => `<tr><td>${esc(h.quarter || '')}</td><td class="num">${fmtEps(h.epsActual)}</td><td class="num">${fmtEps(h.epsEstimate)}</td><td class="num">${fmtPct2(h.surprisePercent)}</td></tr>`)
      .join('');
    return `<div class="table-wrap an-section">
      <h3>Earnings history</h3>
      <div class="table-scroll"><table><thead><tr><th>Quarter</th><th class="num">EPS actual</th><th class="num">EPS estimate</th><th class="num">Surprise</th></tr></thead>
      <tbody>${histRows || '<tr><td colspan="4" class="muted">No data.</td></tr>'}</tbody></table></div>
    </div>`;
  }
  // Every section below "Earnings trends" — same tables on the Analysis tab
  // and the Research & Projections tab, same underlying anData either way.
  function allTablesHtml(revenueTitle, revenuePeriods, historyPeriod) {
    return estimateTablesHtml(revenueTitle, revenuePeriods, historyPeriod) + earningsHistoryHtml() + recommendationTrendHtml();
  }

  function renderAnalysis() {
    const wrap = $('#an-content');
    if (!anData) { wrap.innerHTML = '<p class="muted">No analysis data available.</p>'; return; }
    wrap.innerHTML = earningsTrendsHtml('an', anChartPeriod) + allTablesHtml();
    wireEarningsTrendsToggle('an', () => anChartPeriod, (v) => { anChartPeriod = v; }, renderAnalysis);
  }

  $('#sp-page-add').addEventListener('click', () => {
    if (!current) return;
    close();
    if (window.App && App.addFromMarket) App.addFromMarket(current, lastPrice || '');
  });

  window.StockPage = { show, close };
})();
