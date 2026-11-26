// home.js — the market Home page (biggest movers, all-stocks search, your
// holdings' news).
//
// Opened from the rail "Home" button and the brand logo. Unlike the portfolio
// summary, this shows no holdings — just a market overview, all priced through
// the Yahoo/Finnhub cache. Overlay page like stock.js / connectors.
// Indices/currencies used to have their own card grid here too, but that was
// redundant with the topbar's own live ticker strip (see ticker.js) — removed.

(() => {
  const $ = (s) => document.querySelector(s);
  const page = $('#home-page');
  if (!page) return;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pctTxt = (d) => (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2) + '%';
  const cls = (d) => (d > 0 ? 'up' : d < 0 ? 'down' : '');

  function moverRow(x) {
    // Day's dollar change, derived from price + day% (same baseline
    // /api/movers' `d` is already computed against server-side — see
    // quotes.js) since the payload doesn't carry prevClose separately.
    // A -100% day (effectively delisted/worthless) divides by zero here —
    // Number.isFinite guards that instead of letting NaN/Infinity reach
    // fmtMoney and break this row (and, since renderMovers maps the whole
    // list in one go, every row after it too).
    const rawChange = x.d ? x.price - x.price / (1 + x.d / 100) : 0;
    const changeAmt = Number.isFinite(rawChange) ? rawChange : 0;
    return `<button class="hm-mover" data-sym="${esc(x.s)}">
      <span class="hm-mover-sym">${esc(x.s)}<span class="hm-mover-name">${esc(x.n)}</span></span>
      <span class="hm-mover-spark" data-spark="${esc(x.s)}"></span>
      <span class="hm-mover-open">
        <span class="hm-mover-open-label">Open</span>
        <span class="hm-mover-open-price">${x.open ? window.fmtMoney(x.s, x.open) : '—'}</span>
      </span>
      <span class="hm-mover-current">
        <span class="hm-mover-price">${window.fmtMoney(x.s, x.price)}</span>
        <span class="hm-mover-chg ${cls(x.d)}">${x.d >= 0 ? '+' : '−'}${window.fmtMoney(x.s, Math.abs(changeAmt))} (${pctTxt(x.d)})</span>
      </span>
    </button>`;
  }

  // Attach names from the universe and keep only recognised stocks; cap at 10.
  function named(list) {
    const out = [];
    for (const x of list) {
      const meta = window.Market && Market.get(x.s);
      if (!meta) continue;
      out.push({ ...x, n: meta.n || x.s });
      if (out.length >= 10) break;
    }
    return out;
  }

  // Mini "today so far" line chart per mover row — same /api/intraday
  // connector the stock page's own 1D chart uses (real 1-minute bars, no
  // separate data source), just miniaturized: no axes/labels, a colored
  // line matching the row's up/down, light fill under it, and a dotted
  // baseline at the day's first print (the closest cheap stand-in for
  // previous close in this compact a space).
  function sparkSvg(points, up) {
    if (!points || points.length < 2) return '';
    const W = 80;
    const H = 32;
    let minP = Infinity;
    let maxP = -Infinity;
    for (const [, p] of points) { if (p < minP) minP = p; if (p > maxP) maxP = p; }
    const spanP = maxP - minP || 1;
    const t0 = points[0][0];
    const t1 = points[points.length - 1][0];
    const spanT = t1 - t0 || 1;
    const x = (ts) => ((ts - t0) / spanT) * W;
    const y = (p) => 2 + (1 - (p - minP) / spanP) * (H - 4);
    let d = '';
    points.forEach(([ts, p], i) => { d += (i ? 'L' : 'M') + x(ts).toFixed(1) + ' ' + y(p).toFixed(1); });
    const area = `M0 ${H} ` + d.replace(/^M/, 'L') + ` L${W} ${H} Z`;
    const baseline = y(points[0][1]).toFixed(1);
    const col = up ? 'var(--up)' : 'var(--down)';
    return `<svg class="hm-spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line x1="0" y1="${baseline}" x2="${W}" y2="${baseline}" stroke="var(--border)" stroke-dasharray="2,2" />
      <path d="${area}" fill="${col}" opacity="0.15" />
      <path d="${d}" fill="none" stroke="${col}" stroke-width="1.5" />
    </svg>`;
  }

  // Fetched after the rows themselves render (price/name/change are cheap
  // and already known from /api/movers) — the intraday chart per symbol is
  // its own request, same as the stock page's 1D chart, so it fills in a
  // beat later rather than blocking the whole list on ~20 fetches.
  async function renderMoverSparks(list) {
    await Promise.all(list.map(async (x) => {
      const el = $(`[data-spark="${CSS.escape(x.s)}"]`);
      if (!el) return;
      try {
        const r = await fetch('/api/intraday/' + encodeURIComponent(x.s));
        const d = await r.json();
        const points = (d.points || []).filter(([, p]) => typeof p === 'number' && p > 0);
        el.innerHTML = sparkSvg(points, x.d >= 0);
      } catch {}
    }));
  }

  // Retry state for the "universe not loaded yet" case below — cleared
  // whenever a real refresh (interval tick or reopening Home) supersedes it.
  // Capped at 8 tries (~6.5s) so a genuinely failed /api/symbols load (not
  // just "still loading") doesn't retry forever while Home stays open.
  let moversRetryTimer = null;
  let moversRetryCount = 0;

  async function renderMovers() {
    clearTimeout(moversRetryTimer);
    let d = { gainers: [], losers: [] };
    try { d = await (await fetch('/api/movers')).json(); } catch {}
    const rawGainers = d.gainers || [];
    const rawLosers = d.losers || [];
    const g = named(rawGainers);
    const l = named(rawLosers);
    $('#hm-gainers').innerHTML = g.map(moverRow).join('') || '<p class="muted hm-none">No data yet.</p>';
    $('#hm-losers').innerHTML = l.map(moverRow).join('') || '<p class="muted hm-none">No data yet.</p>';
    renderMoverSparks([...g, ...l]);
    // named() needs Market's full symbol universe (market.js) loaded to
    // attach a name to each ticker — if /api/movers itself had real rows but
    // named() matched none of them, the universe almost certainly just
    // hadn't finished its own fetch yet at this exact moment. Rather than
    // sitting on "No data yet." until the next 20s refresh tick, retry
    // quickly a few times so it catches up within a couple of seconds.
    if ((rawGainers.length || rawLosers.length) && !g.length && !l.length && moversRetryCount < 8) {
      moversRetryCount++;
      moversRetryTimer = setTimeout(() => { if (!page.hidden) renderMovers(); }, 800);
    } else {
      moversRetryCount = 0;
    }
  }

  // ── "Your holdings — news" ──────────────────────────────────────────────
  // Same per-symbol Yahoo search connector as the stock page's News tab
  // (server/yahoo-news.js via /api/news/<symbol>) — fetched once per real
  // (non-cash) holding across every portfolio, merged, and sorted newest
  // first. Deliberately un-cached client-side too, same as the News tab:
  // whatever's freshest each time Home is opened.
  function fmtNewsTime(ts) {
    if (!ts) return '';
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 60) return mins <= 1 ? 'just now' : mins + 'm ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.round(hours / 24) + 'd ago';
  }
  // Sharesies' cash-like imports use synthetic tickers, not real market
  // symbols (KIWISAVER.NZ, CASH-<SLUG>.NZ — see cashLabel in app.js); no
  // stock, so no news to fetch for them.
  const isCashTicker = (t) => t === 'KIWISAVER.NZ' || /^CASH-.+\.NZ$/.test(String(t || ''));
  // Same key stock.js's star button reads/writes (see FAV_KEY there).
  const FAV_KEY = 'cashmoney.favourites';
  function favouriteTickers() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]').map((t) => String(t).toUpperCase()); } catch { return []; }
  }

  async function holdingTickers() {
    const seen = new Set();
    const out = [];
    const add = (t) => { if (t && !isCashTicker(t) && !seen.has(t)) { seen.add(t); out.push(t); } };
    try {
      const { positions } = await Store.loadAll();
      // Only portfolios linked (ticked) to the summary — same set the
      // summary's own numbers use (getLinkedSet in app.js).
      const linked = typeof getLinkedSet === 'function' ? getLinkedSet() : null;
      for (const p of positions) {
        if (linked && !linked.has(p.portfolio_id)) continue;
        add(String(p.ticker || '').toUpperCase());
      }
    } catch {}
    for (const t of favouriteTickers()) add(t);
    return out;
  }

  // A stock's company suffix ("Inc.", "Corp", "Group", "plc", ...) rarely
  // shows up verbatim in a headline the way the core name does ("Apple",
  // not "Apple Inc.") — stripped before matching so a real hit isn't missed
  // over a formality. See titleMentionsHolding.
  const NAME_SUFFIX = /\s+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|the)\.?\s*$/i;
  function coreName(n) {
    let s = String(n || '').trim();
    let prev;
    do { prev = s; s = s.replace(NAME_SUFFIX, '').trim(); } while (s !== prev && s);
    return s;
  }
  // Precision over recall: relatedTickers (Yahoo's own tagging) still gets
  // it wrong often enough to surface stories about stocks you don't hold
  // (see renderHoldingsNews's earlier bug where NVDA's news query alone
  // pulled in Paramount, GE Vernova, Fifth Third Bancorp...) — so beyond
  // that tag, the story's own title must actually name the ticker or the
  // company, word-bounded so e.g. ticker "O" or "GE" can't match inside an
  // unrelated word.
  function titleMentionsHolding(title, ticker, name) {
    const t = String(title || '');
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escRe(ticker)}\\b`, 'i').test(t)) return true;
    const core = coreName(name);
    return core.length > 2 && new RegExp(`\\b${escRe(core)}\\b`, 'i').test(t);
  }

  // A story can carry a dozen relatedTickers (see Arm/defense-spending
  // examples above) — sort the held one(s) to the front first so truncating
  // to a handful of chips can't hide the very reason this story is in your
  // feed behind unrelated tickers that happened to list first.
  function sortHeldFirst(tickers, held) {
    return [...(tickers || [])].sort((a, b) => held.has(String(b).toUpperCase()) - held.has(String(a).toUpperCase()));
  }
  function newsHeroCard(n, held) {
    const chips = sortHeldFirst(n.relatedTickers, held).slice(0, 6).map((t) => `<span class="news-chip">${esc(t)}</span>`).join('');
    // No placeholder box when there's no image — renderHoldingsNews already
    // prefers a hero story that has one, so this is just the rare fallback
    // when nothing in the batch does.
    const img = n.image ? `<img class="hm-news-hero-img" src="${esc(n.image)}" alt="" loading="lazy" />` : '';
    return `<a class="hm-news-hero" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
      ${img}
      <p class="hm-news-hero-title">${esc(n.title)}</p>
      <p class="hm-news-hero-meta">${esc(n.publisher)}${n.time ? ' · ' + esc(fmtNewsTime(n.time)) : ''}</p>
      ${chips ? `<div class="hm-news-hero-chips">${chips}</div>` : ''}
    </a>`;
  }
  function newsSideItem(n, held) {
    const chips = sortHeldFirst(n.relatedTickers, held).slice(0, 3).map((t) => `<span class="news-chip">${esc(t)}</span>`).join('');
    const img = n.image ? `<img class="news-thumb" src="${esc(n.image)}" alt="" loading="lazy" />` : '<div class="news-thumb news-thumb-empty"></div>';
    return `<a class="news-item" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
      ${img}
      <div class="news-body">
        <p class="news-title">${esc(n.title)}</p>
        <p class="news-meta">${esc(n.publisher)}${n.time ? ' · ' + esc(fmtNewsTime(n.time)) : ''}</p>
        ${chips ? `<div class="news-chips">${chips}</div>` : ''}
      </div>
    </a>`;
  }

  async function renderHoldingsNews() {
    const section = $('#hm-news-section');
    const wrap = $('#hm-news');
    const tickers = await holdingTickers();
    if (!tickers.length) { section.hidden = true; return; }
    section.hidden = false;
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const perSymbol = await Promise.all(
        tickers.map((t) => fetch('/api/news/' + encodeURIComponent(t)).then((r) => r.json()).then((d) => d.news || []).catch(() => []))
      );
      // Yahoo's search endpoint (server/yahoo-news.js) is fuzzy, not an exact
      // per-symbol feed — querying a popular ticker like NVDA also surfaces
      // unrelated trending stories (Paramount, GE Vernova, ...) that just
      // happen to rank near it, and even relatedTickers (Yahoo's own tagging)
      // isn't precise enough on its own to rule those out reliably. Highest
      // bar: the headline itself has to actually name a held/favourited
      // ticker or company (see titleMentionsHolding) — precision over
      // recall, since this is meant to read as "your" news, not "vaguely
      // trending near your holdings".
      const held = new Set(tickers);
      const byLink = new Map();
      for (const items of perSymbol) {
        for (const n of items) {
          if (!n.link || byLink.has(n.link)) continue;
          const matches = tickers.some((t) => titleMentionsHolding(n.title, t, window.Market && Market.get(t) && Market.get(t).n));
          if (!matches) continue;
          byLink.set(n.link, n);
        }
      }
      const merged = [...byLink.values()].sort((a, b) => (b.time || 0) - (a.time || 0));
      if (!merged.length) { wrap.innerHTML = '<p class="muted">No recent news for your holdings.</p>'; return; }
      // The hero card is a big 16:9 box — not every story has a thumbnail
      // (Yahoo doesn't require one), and running one of those as hero just
      // shows an oversized empty placeholder while stories with real images
      // sit in the sidebar below it. Prefer the newest story that actually
      // has one; only fall back to the newest overall if none in the batch do.
      const heroIdx = merged.findIndex((n) => n.image);
      const hero = merged[heroIdx >= 0 ? heroIdx : 0];
      const rest = merged.filter((n) => n !== hero);
      wrap.innerHTML = newsHeroCard(hero, held) + `<div class="hm-news-side">${rest.slice(0, 8).map((n) => newsSideItem(n, held)).join('')}</div>`;
    } catch {
      wrap.innerHTML = '<p class="muted">Could not load news.</p>';
    }
  }

  function refresh() {
    renderMovers();
  }

  let timer = null;
  function show() {
    if (window.Nav) Nav.push({ type: 'home' });
    if (window.StockPage) StockPage.close();
    if (window.ConnectorsPage) ConnectorsPage.close();
    if (window.ProfilePage) ProfilePage.close();
    if (window.ResearchPage) ResearchPage.close();
    if (window.EarningsCalendarPage) EarningsCalendarPage.close();
    if (window.CompoundPage) CompoundPage.close();
    if (window.SettingsPage) SettingsPage.close();
    if (window.NotificationsPage) NotificationsPage.close();
    document.body.classList.add('home-open');
    page.hidden = false;
    window.scrollTo(0, 0);
    refresh();
    // Un-cached live news per holding (see renderHoldingsNews) — only worth
    // re-fetching each time Home is actually opened, not on the 20s market-
    // data refresh tick below.
    renderHoldingsNews();
    clearInterval(timer);
    timer = setInterval(() => { if (!page.hidden) refresh(); }, 20000);
  }
  function close() {
    document.body.classList.remove('home-open');
    page.hidden = true;
    clearInterval(timer);
  }

  page.addEventListener('click', (e) => {
    const el = e.target.closest('[data-sym]');
    if (!el || !window.StockPage) return;
    StockPage.show(el.dataset.sym); // a mover stock
  });

  window.HomePage = { show, close };
})();
