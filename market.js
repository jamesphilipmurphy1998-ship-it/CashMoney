// market.js — searchable stock library with index tags and live quotes.
//
// The universe comes from /api/symbols (all symbols, each tagged with the
// indexes it belongs to). Live prices come from /api/quotes. The list can be
// mounted in more than one place (Home page + portfolio pages): universe and
// quotes are shared/fetched once, but each mounted block keeps its own search
// text and active filter. Any element with class "market-block" is mounted.

(() => {
  const $ = (s) => document.querySelector(s);
  const MAX_ROWS = 150; // cap rendered rows; the universe is thousands

  // Shared across all mounted blocks.
  let universe = [];
  let bySymbol = new Map();
  let quotes = {};
  const instances = [];

  const fmtPrice = (s, n) => (n ? window.fmtMoney(s, n) : '—');
  const fmtPct = (n) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%';
  const sign = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function cssEsc(s) {
    return s.replace(/["\\]/g, '\\$&');
  }
  // Some source names (e.g. Nikkei from Wikipedia) carry raw HTML entities like
  // "&amp;". Decode once so display isn't double-escaped.
  const _dec = document.createElement('textarea');
  function decodeEntities(s) {
    if (!s || s.indexOf('&') < 0) return s;
    _dec.innerHTML = s;
    return _dec.value;
  }
  function tagChips(x) {
    if (!x.tags || !x.tags.length) return '';
    return '<span class="mtags">' + x.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') + '</span>';
  }

  // Ranks universe entries against a search term: exact ticker, ticker-prefix,
  // name-prefix, a name word starting with it, ticker substring, name
  // substring, then a tag substring (weakest match). Shared by the in-
  // portfolio/Home "Market" search list and the topbar global search, so
  // results are ordered by relevance everywhere — previously the Market
  // list just kept the universe's alphabetical-by-ticker order and hard-
  // capped display at MAX_ROWS, which could silently drop a clearly-relevant
  // match (e.g. INTC for "intel") once enough less-relevant matches came
  // earlier alphabetically, especially under a broad filter like "All".
  function rankMatches(list, f) {
    const scored = [];
    for (const x of list) {
      const sym = x.s.toLowerCase();
      const name = (x.n || '').toLowerCase();
      let score = -1;
      if (sym === f) score = 0; // exact ticker
      else if (sym.startsWith(f)) score = 1; // ticker prefix (AMD for "am")
      else if (name.startsWith(f)) score = 2; // name prefix
      else if (name.split(/[^a-z0-9]+/).some((w) => w.startsWith(f))) score = 3; // a word starts with it
      else if (sym.includes(f)) score = 4; // ticker substring
      else if (name.includes(f)) score = 5; // name substring
      else if (x.tags && x.tags.some((t) => t.toLowerCase().includes(f))) score = 6; // tag substring (weakest)
      if (score < 0) continue;
      const known = x.tags && x.tags.length ? 0 : 1; // index members rank first
      scored.push({ x, score, known, len: x.s.length });
    }
    scored.sort((a, b) => a.score - b.score || a.known - b.known || a.len - b.len || (a.x.s < b.x.s ? -1 : 1));
    return scored.map((s) => s.x);
  }

  // Mount a single search block. Returns handles the shared loop calls to keep
  // it in sync. Each block has its own filter text and active tag.
  function mountMarket(root) {
    const listEl = root.querySelector('.mkt-list');
    const searchEl = root.querySelector('.mkt-search');
    const filtersEl = root.querySelector('.mkt-filters');
    const statusEl = root.querySelector('.mkt-status');
    if (!listEl || !searchEl || !filtersEl) return null;

    let filter = '';
    let activeTag = null; // null = All
    let searchTimer;
    const allowAdd = root.dataset.quickadd !== 'off'; // Home list has no quick-add
    if (!allowAdd) listEl.classList.add('no-add');

    function filtered() {
      const f = filter.toLowerCase();
      const base = universe.filter((x) => !activeTag || (x.tags && x.tags.includes(activeTag)));
      return f ? rankMatches(base, f) : base;
    }

    function renderFilters() {
      const counts = new Map();
      for (const x of universe) for (const t of x.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
      const tags = [...counts.keys()];
      const chip = (label, tag, count) =>
        `<button class="fchip ${activeTag === tag ? 'active' : ''}" data-tag="${tag == null ? '' : esc(tag)}">${esc(label)}${count != null ? ` <span class="fcount">${count}</span>` : ''}</button>`;
      filtersEl.innerHTML = chip('All', null, null) + tags.map((t) => chip(t, t, counts.get(t))).join('');
    }

    function renderList() {
      const all = filtered();
      const rows = all.slice(0, MAX_ROWS);
      listEl.innerHTML = rows
        .map((x) => {
          const q = quotes[x.s];
          const day = q ? q.day : null;
          return `<button class="mrow" data-sym="${esc(x.s)}">
            <span class="msym">${esc(x.s)}</span>
            <span class="mname">${esc(x.n || '')}${tagChips(x)}</span>
            ${allowAdd ? `<span class="mq-add" data-add="${esc(x.s)}" title="Quick add to this portfolio" role="button">+</span>` : ''}
            <span class="mprice" data-price="${esc(x.s)}">${q ? fmtPrice(x.s, q.price) : '—'}</span>
            <span class="mday ${day == null ? '' : sign(day)}" data-day="${esc(x.s)}">${day == null ? '' : fmtPct(day)}</span>
          </button>`;
        })
        .join('');
      if (!all.length) {
        listEl.innerHTML = '<p class="empty">No matches.</p>';
      } else if (all.length > MAX_ROWS) {
        listEl.insertAdjacentHTML('beforeend', `<p class="mmore">Showing ${MAX_ROWS} of ${all.length.toLocaleString()} — keep typing to narrow.</p>`);
      }
    }

    function refreshCells() {
      for (const sym in quotes) {
        const q = quotes[sym];
        const p = listEl.querySelector(`[data-price="${cssEsc(sym)}"]`);
        const d = listEl.querySelector(`[data-day="${cssEsc(sym)}"]`);
        if (p) p.textContent = fmtPrice(sym, q.price);
        if (d) {
          d.textContent = fmtPct(q.day);
          d.className = 'mday ' + sign(q.day);
        }
      }
    }

    filtersEl.addEventListener('click', (e) => {
      const b = e.target.closest('.fchip');
      if (!b) return;
      activeTag = b.dataset.tag || null;
      renderFilters();
      renderList();
    });
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { filter = searchEl.value.trim(); renderList(); }, 120);
    });
    listEl.addEventListener('click', (e) => {
      const add = e.target.closest('.mq-add');
      if (add) {
        e.stopPropagation();
        const sym = add.dataset.add;
        if (window.App && window.App.quickAdd) {
          const q = quotes[sym];
          if (window.App.quickAdd(sym, q ? q.price : 0)) {
            add.textContent = '✓';
            add.classList.add('added');
          }
        }
        return;
      }
      const row = e.target.closest('.mrow');
      if (row) openStock(row.dataset.sym);
    });

    const inst = { renderFilters, renderList, refreshCells, setStatus: (t) => { if (statusEl) statusEl.textContent = t; } };
    instances.push(inst);
    return inst;
  }

  async function loadUniverse() {
    try {
      const r = await fetch('/api/symbols');
      const d = await r.json();
      universe = d.symbols || [];
      for (const x of universe) if (x.n) x.n = decodeEntities(x.n); // fix "&amp;" etc.
      bySymbol = new Map(universe.map((x) => [x.s, x]));
      instances.forEach((i) => { i.renderFilters(); i.renderList(); });
    } catch {
      instances.forEach((i) => i.setStatus('Could not load stock list'));
    }
  }

  async function poll() {
    try {
      const r = await fetch('/api/quotes');
      const data = await r.json();
      quotes = data.quotes || {};
      // `enabled` only reflects the shared server-wide key (server/.env's
      // FINNHUB_KEY) — a user's own personal key (Connectors page) still
      // prices real quotes into this same snapshot without it, so check
      // personalKeys too before calling live data "off" outright.
      const status = data.enabled
        ? `Live · ${data.count} priced · ${universe.length.toLocaleString()} searchable`
        : data.personalKeys > 0
          ? `Live via ${data.personalKeys} personal key${data.personalKeys === 1 ? '' : 's'} · ${data.count} priced · ${universe.length.toLocaleString()} searchable`
          : 'Live data off — add a Finnhub key in server/.env';
      instances.forEach((i) => { i.setStatus(status); i.refreshCells(); });
    } catch {
      instances.forEach((i) => i.setStatus('Offline'));
    }
  }

  // ── detail dialog (shared) ─────────────────────────────────────────────
  const dlg = $('#stock-dialog');
  let detailSym = null;

  async function openDetail(sym) {
    const meta = bySymbol.get(sym) || { s: sym, n: sym, tags: [] };
    detailSym = sym;
    $('#sd-symbol').textContent = sym;
    $('#sd-name').textContent = meta.n + (meta.sec ? ' · ' + meta.sec : '');
    $('#sd-price').textContent = '—';
    $('#sd-change').textContent = '';
    $('#sd-change').className = 'sd-change';
    $('#sd-grid').innerHTML = (meta.tags && meta.tags.length ? '<div class="sd-tags">' + meta.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') + '</div>' : '') + '<span class="sd-loading">Loading…</span>';
    dlg.showModal();

    try {
      const r = await fetch('/api/stock/' + encodeURIComponent(sym));
      const d = await r.json();
      const q = d.quote;
      const p = d.profile;
      if (q) {
        $('#sd-price').textContent = fmtPrice(sym, q.price);
        $('#sd-change').textContent = fmtPct(q.day);
        $('#sd-change').className = 'sd-change ' + sign(q.day);
      }
      const cells = [
        ['Day high', q ? fmtPrice(sym, q.high) : '—'],
        ['Day low', q ? fmtPrice(sym, q.low) : '—'],
        ['Prev close', q ? fmtPrice(sym, q.prevClose) : '—'],
        ['Market cap', p && p.marketCap ? '$' + Math.round(p.marketCap).toLocaleString() + 'M' : '—'],
        ['Sector', meta.sec || '—'],
        ['Industry', (p && p.industry) || '—'],
      ];
      const tags = meta.tags && meta.tags.length ? '<div class="sd-tags">' + meta.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') + '</div>' : '';
      $('#sd-grid').innerHTML = tags + cells.map(([k, v]) => `<div class="sd-cell"><span class="sd-k">${k}</span><span class="sd-v">${esc(String(v))}</span></div>`).join('');
    } catch {
      $('#sd-grid').innerHTML = '<span class="sd-loading">Could not load details.</span>';
    }
  }

  // Clicking a stock opens its full page (stock.js); the dialog is a fallback.
  function openStock(sym) {
    if (window.StockPage) window.StockPage.show(sym);
    else openDetail(sym);
  }

  if (dlg) {
    $('#sd-close').addEventListener('click', () => dlg.close());
    $('#sd-add').addEventListener('click', () => {
      if (detailSym && window.App && window.App.addFromMarket) {
        const q = quotes[detailSym];
        dlg.close();
        window.App.addFromMarket(detailSym, q ? q.price : '');
      }
    });
  }

  // ── go ─────────────────────────────────────────────────────────────────
  document.querySelectorAll('.market-block').forEach(mountMarket);
  loadUniverse();
  poll();
  setInterval(poll, 15000);

  // Shared with the topbar search + stock page: the same universe.
  window.Market = {
    openDetail: openStock,
    get: (s) => bySymbol.get(s),
    all: () => universe,
    search(text, max = 8) {
      const f = String(text || '').toLowerCase().trim();
      if (!f) return [];
      return rankMatches(universe, f).slice(0, max);
    },
  };
})();
