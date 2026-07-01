// market.js — searchable stock library with index tags and live quotes.
//
// The universe comes from /api/symbols (all US stocks Finnhub exposes, each
// tagged with the indexes it belongs to, e.g. "S&P 500"). Live prices come
// from /api/quotes (server fetches them from Finnhub in the background,
// prioritised by tag). Rows render on search; only price/change cells update
// on poll.

(() => {
  const $ = (s) => document.querySelector(s);

  const listEl = $('#market-list');
  const searchEl = $('#market-search');
  const statusEl = $('#market-status');
  const filtersEl = $('#market-filters');

  const MAX_ROWS = 150; // cap rendered rows; the universe is thousands

  let universe = [];
  let bySymbol = new Map();
  let quotes = {};
  let filter = '';
  let activeTag = null; // null = All

  const fmtPrice = (n) => (n ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
  const fmtPct = (n) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%';
  const sign = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

  function filtered() {
    const f = filter.toLowerCase();
    return universe.filter((x) => {
      if (activeTag && !(x.tags && x.tags.includes(activeTag))) return false;
      if (!f) return true;
      return x.s.toLowerCase().includes(f) || (x.n && x.n.toLowerCase().includes(f)) || (x.tags && x.tags.some((t) => t.toLowerCase().includes(f)));
    });
  }

  // Build filter chips from the index tags actually present in the universe.
  function renderFilters() {
    const counts = new Map();
    for (const x of universe) for (const t of x.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    const tags = [...counts.keys()];
    const chip = (label, tag, count) =>
      `<button class="fchip ${activeTag === tag ? 'active' : ''}" data-tag="${tag == null ? '' : esc(tag)}">${esc(label)}${count != null ? ` <span class="fcount">${count}</span>` : ''}</button>`;
    filtersEl.innerHTML = chip('All', null, null) + tags.map((t) => chip(t, t, counts.get(t))).join('');
  }

  filtersEl.addEventListener('click', (e) => {
    const b = e.target.closest('.fchip');
    if (!b) return;
    activeTag = b.dataset.tag || null;
    renderFilters();
    renderList();
  });

  function tagChips(x) {
    if (!x.tags || !x.tags.length) return '';
    return '<span class="mtags">' + x.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') + '</span>';
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
          <span class="mprice" data-price="${esc(x.s)}">${q ? fmtPrice(q.price) : '—'}</span>
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
      if (p) p.textContent = fmtPrice(q.price);
      if (d) {
        d.textContent = fmtPct(q.day);
        d.className = 'mday ' + sign(q.day);
      }
    }
  }

  async function loadUniverse() {
    try {
      const r = await fetch('/api/symbols');
      const d = await r.json();
      universe = d.symbols || [];
      bySymbol = new Map(universe.map((x) => [x.s, x]));
      renderFilters();
      renderList();
    } catch {
      statusEl.textContent = 'Could not load stock list';
    }
  }

  async function poll() {
    try {
      const r = await fetch('/api/quotes');
      const data = await r.json();
      quotes = data.quotes || {};
      if (!data.enabled) statusEl.textContent = 'Live data off — add a Finnhub key in server/.env';
      else statusEl.textContent = `Live · ${data.count} priced · ${universe.length.toLocaleString()} searchable`;
      refreshCells();
    } catch {
      statusEl.textContent = 'Offline';
    }
  }

  // ── detail dialog ──────────────────────────────────────────────────────
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
        $('#sd-price').textContent = fmtPrice(q.price);
        $('#sd-change').textContent = fmtPct(q.day);
        $('#sd-change').className = 'sd-change ' + sign(q.day);
      }
      const cells = [
        ['Day high', q ? fmtPrice(q.high) : '—'],
        ['Day low', q ? fmtPrice(q.low) : '—'],
        ['Prev close', q ? fmtPrice(q.prevClose) : '—'],
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

  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.mrow');
    if (row) openDetail(row.dataset.sym);
  });
  $('#sd-close').addEventListener('click', () => dlg.close());
  $('#sd-add').addEventListener('click', () => {
    if (detailSym && window.App && window.App.addFromMarket) {
      const q = quotes[detailSym];
      dlg.close();
      window.App.addFromMarket(detailSym, q ? q.price : '');
    }
  });

  // ── search ─────────────────────────────────────────────────────────────
  let searchTimer;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filter = searchEl.value.trim();
      renderList();
    }, 120);
  });

  // ── helpers ────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function cssEsc(s) {
    return s.replace(/["\\]/g, '\\$&');
  }

  // ── go ─────────────────────────────────────────────────────────────────
  loadUniverse();
  poll();
  setInterval(poll, 15000);
})();
