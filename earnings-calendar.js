// earnings-calendar.js — an Outlook-style month grid of earnings dates
// across every stock the user actually cares about: S&P 500 / Nasdaq 100 /
// Dow 30 constituents, everything held in any of their portfolios, and
// every starred favourite. Pulled from the same Statistics connector
// (calendarEvents) the stock page's Summary tab uses, batched through
// /api/earnings-calendar — a symbol already warmed by the fortnightly
// financials sweep, or by opening its own stock page, just returns
// instantly from that cache; nothing here is a separate scrape.

(() => {
  const $ = (s) => document.querySelector(s);
  const page = $('#earnings-calendar-page');
  if (!page) return;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const INDEX_TAGS = ['S&P 500', 'Nasdaq 100', 'Dow 30'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // Symbols the user owns or has starred — drawn gold on the calendar.
  let mineSymbols = new Set();

  async function gatherSymbols() {
    const set = new Set();
    const mine = new Set();
    if (window.Market) {
      for (const x of Market.all()) {
        if (x.tags && x.tags.some((t) => INDEX_TAGS.includes(t))) set.add(x.s);
      }
    }
    if (window.Favourites) for (const s of Favourites.list()) { set.add(s); mine.add(String(s).toUpperCase()); }
    // Independently loaded rather than reusing app.js's own aggregate-view
    // cache — this page can be opened before that view ever has been, and
    // holdings are what actually make this "your" earnings calendar.
    try {
      const all = await Store.loadAll();
      for (const p of all.positions || []) if (p.ticker) { const t = String(p.ticker).toUpperCase(); set.add(t); mine.add(t); }
    } catch {}
    mineSymbols = mine;
    return [...set];
  }

  // Batched — a single request with 500+ symbols risks an overlong URL and
  // one slow round trip; smaller parallel chunks are both safer and let
  // results start arriving sooner.
  const CHUNK = 150;
  async function fetchEarnings(symbols) {
    const chunks = [];
    for (let i = 0; i < symbols.length; i += CHUNK) chunks.push(symbols.slice(i, i + CHUNK));
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const r = await fetch('/api/earnings-calendar?symbols=' + encodeURIComponent(chunk.join(',')));
          const d = await r.json();
          return d.earnings || [];
        } catch {
          return [];
        }
      })
    );
    return results.flat();
  }

  // Cached across month navigation — Yahoo only ever gives one upcoming
  // earnings date per symbol anyway (not a full year's worth), so there's
  // nothing to re-fetch just for flipping between months; only a fresh
  // page open re-pulls it.
  let earningsBySymbol = null; // Map<symbol, {earningsDate, name}>
  let loadToken = 0; // guards against a slower earlier load finishing after a newer one
  let viewYear, viewMonth; // 0-indexed month, like Date's own convention
  let highlightKey = null; // "YYYY-MM-DD" of a searched-for day, cleared on manual navigation

  function todayUTC() {
    const d = new Date();
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
  }

  async function loadData() {
    const myToken = ++loadToken;
    const grid = $('#ec-cal-grid');
    grid.innerHTML = '<p class="muted">Loading…</p>';
    const symbols = await gatherSymbols();
    if (myToken !== loadToken) return;
    if (!symbols.length) {
      grid.innerHTML = '<p class="muted">No stocks to check yet — the index universe may still be loading.</p>';
      return;
    }
    const earnings = await fetchEarnings(symbols);
    if (myToken !== loadToken) return;
    earningsBySymbol = new Map();
    for (const e of earnings) {
      const meta = window.Market && Market.get(e.symbol);
      earningsBySymbol.set(e.symbol, { earningsDate: e.earningsDate, name: (meta && meta.n) || '' });
    }
    renderMonth();
  }

  // Grid cells indexed by "YYYY-MM-DD" (UTC, matching the epoch-seconds
  // dates Yahoo gives) so a day cell just does one Map lookup.
  function eventsByDay() {
    const map = new Map();
    if (!earningsBySymbol) return map;
    for (const [symbol, info] of earningsBySymbol) {
      const d = new Date(info.earningsDate * 1000);
      const key = d.toISOString().slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ symbol, name: info.name });
    }
    return map;
  }

  function renderMonth() {
    $('#ec-cal-title').textContent = `${MONTH_NAMES[viewMonth]} ${viewYear}`;
    const grid = $('#ec-cal-grid');
    const byDay = eventsByDay();
    const firstWeekday = new Date(Date.UTC(viewYear, viewMonth, 1)).getUTCDay(); // 0=Sun
    const daysInMonth = new Date(Date.UTC(viewYear, viewMonth + 1, 0)).getUTCDate();
    const today = todayUTC();
    const cells = [];
    for (let i = 0; i < firstWeekday; i++) cells.push('<div class="ec-cell ec-cell-empty"></div>');
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const events = byDay.get(key) || [];
      const isToday = today.y === viewYear && today.m === viewMonth && today.d === day;
      const isHighlight = key === highlightKey;
      // Gold (owned/starred) first so they never fall under "+N more".
      const sorted = [...events].sort((a, b) => mineSymbols.has(b.symbol.toUpperCase()) - mineSymbols.has(a.symbol.toUpperCase()));
      const chips = sorted
        .slice(0, 4)
        .map((e) => `<button class="ec-chip${mineSymbols.has(e.symbol.toUpperCase()) ? ' ec-chip-mine' : ''}" data-sym="${esc(e.symbol)}" title="${esc(e.name)}">${esc(e.symbol)}</button>`)
        .join('');
      const overflow = events.length > 4 ? `<span class="ec-chip-more">+${events.length - 4} more</span>` : '';
      cells.push(
        `<div class="ec-cell${isToday ? ' ec-cell-today' : ''}${isHighlight ? ' ec-cell-highlight' : ''}" data-key="${key}">
          <span class="ec-cell-day">${day}</span>
          <div class="ec-cell-events">${chips}${overflow}</div>
        </div>`
      );
    }
    // Trailing blanks so the grid always ends on a full week row.
    while (cells.length % 7 !== 0) cells.push('<div class="ec-cell ec-cell-empty"></div>');
    grid.innerHTML = cells.join('');
    if (highlightKey) {
      const cell = grid.querySelector(`[data-key="${highlightKey}"]`);
      if (cell) cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  function clearHighlight() {
    highlightKey = null;
    const result = $('#ec-search-result');
    result.hidden = true;
    result.textContent = '';
  }

  function show() {
    if (window.Nav) Nav.push({ type: 'earnings' });
    if (window.StockPage) StockPage.close();
    if (window.ConnectorsPage) ConnectorsPage.close();
    if (window.HomePage) HomePage.close();
    if (window.ProfilePage) ProfilePage.close();
    if (window.ResearchPage) ResearchPage.close();
    if (window.CompoundPage) CompoundPage.close();
    if (window.SettingsPage) SettingsPage.close();
    document.body.classList.add('earnings-calendar-open');
    page.hidden = false;
    window.scrollTo(0, 0);
    const t = todayUTC();
    viewYear = t.y;
    viewMonth = t.m;
    loadData();
  }
  function close() {
    document.body.classList.remove('earnings-calendar-open');
    page.hidden = true;
  }

  $('#ec-cal-prev').addEventListener('click', () => {
    clearHighlight();
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderMonth();
  });
  $('#ec-cal-next').addEventListener('click', () => {
    clearHighlight();
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderMonth();
  });
  $('#ec-cal-today').addEventListener('click', () => {
    clearHighlight();
    const t = todayUTC();
    viewYear = t.y;
    viewMonth = t.m;
    renderMonth();
  });

  page.addEventListener('click', (e) => {
    const btn = e.target.closest('.ec-chip[data-sym]');
    if (!btn || !window.StockPage) return;
    StockPage.show(btn.dataset.sym, { tab: 'financials' });
  });

  // ── Search: jump the grid to a specific company's earnings date ────────
  // Reuses the same ticker autocomplete pattern as the Bull case
  // calculator's search box. A searched stock may not be in the gathered
  // holdings/favourites/index set, so its date is resolved on demand (via
  // the same batch endpoint, just one symbol) rather than requiring it to
  // already be loaded.
  let searchTimer = null;
  function renderSearchResults(text) {
    const menu = $('#ec-search-menu');
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
  async function goToSymbol(symbol) {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    const result = $('#ec-search-result');
    result.hidden = false;
    result.textContent = 'Looking up ' + sym + '…';
    let info = earningsBySymbol && earningsBySymbol.get(sym);
    if (!info) {
      try {
        const r = await fetch('/api/earnings-calendar?symbols=' + encodeURIComponent(sym));
        const d = await r.json();
        const hit = (d.earnings || [])[0];
        if (hit) {
          const meta = window.Market && Market.get(sym);
          info = { earningsDate: hit.earningsDate, name: (meta && meta.n) || '' };
          if (earningsBySymbol) earningsBySymbol.set(sym, info); // so it shows up on the grid too, not just the banner
        }
      } catch {}
    }
    if (!info) {
      result.textContent = `No upcoming earnings date found for ${sym}.`;
      return;
    }
    const d = new Date(info.earningsDate * 1000);
    viewYear = d.getUTCFullYear();
    viewMonth = d.getUTCMonth();
    highlightKey = d.toISOString().slice(0, 10);
    renderMonth();
    result.textContent = `${sym}${info.name ? ' — ' + info.name : ''} reports on ${d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}.`;
  }
  $('#ec-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const text = e.target.value.trim();
    searchTimer = setTimeout(() => renderSearchResults(text), 120);
  });
  $('#ec-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#ec-search-menu').hidden = true; goToSymbol(e.target.value); }
    if (e.key === 'Escape') { $('#ec-search-menu').hidden = true; }
  });
  $('#ec-search-menu').addEventListener('click', (e) => {
    const item = e.target.closest('.ts-item[data-sym]');
    if (!item) return;
    $('#ec-search').value = item.dataset.sym;
    $('#ec-search-menu').hidden = true;
    goToSymbol(item.dataset.sym);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ec-search-wrap')) $('#ec-search-menu').hidden = true;
  });

  window.EarningsCalendarPage = { show, close };
})();
