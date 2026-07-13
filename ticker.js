// ticker.js — Yahoo-style market strip of index/ETF quotes with daily change.
//
// Shows real Yahoo index/spot levels (^GSPC, GC=F, …) and FX pairs (…=X)
// directly — not ETF proxies. That used to be necessary when Finnhub (US
// stocks/ETFs only, free tier) was the only quote source, but /api/ticker
// now falls back to Yahoo for anything Finnhub can't price, so the real
// index level is no less "live" than an ETF share price. Values come live
// from our own /api/ticker, which prices whatever symbols we ask for and
// keeps them fresh. The user can add more tickers (+) or remove them (× on
// hover); the list persists in localStorage.

(() => {
  const el = document.getElementById('ticker');
  if (!el) return;

  const KEY = 'cashmoney.tickerSyms';
  const VER_KEY = 'cashmoney.tickerSyms.v';
  const VERSION = '4';
  // Real Yahoo index/spot symbols (^…, …=F) and FX pairs (…=X) — see the
  // note above on why these replaced the old ETF proxies (SPY/QQQ/DIA/IWM/GLD).
  const DEFAULTS = [
    '^GSPC', '^NDX', '^DJI', 'GC=F', '^RUT', '^FTSE', '^GDAXI', '^N225',
    'DX-Y.NYB', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'NZDUSD=X', 'USDCAD=X', 'USDCHF=X', 'USDCNY=X',
  ];
  // v1 -> v3 additions, appended to existing saved strips on upgrade.
  const ADDED = ['^FTSE', '^GDAXI', '^N225', 'DX-Y.NYB', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'NZDUSD=X', 'USDCAD=X', 'USDCHF=X', 'USDCNY=X'];
  // v3 -> v4: swap each ETF proxy for the real index/spot symbol it tracked.
  const SWAP = { SPY: '^GSPC', QQQ: '^NDX', DIA: '^DJI', IWM: '^RUT', GLD: 'GC=F' };
  // Friendly labels for the well-known symbols; anything else shows its ticker.
  const NAMES = {
    SPY: 'S&P 500', QQQ: 'Nasdaq 100', DIA: 'Dow Jones', GLD: 'Gold',
    IWM: 'Russell 2000', SLV: 'Silver', TLT: '20Y Treasury', HYG: 'High Yield',
    USO: 'Oil', VNQ: 'Real Estate', EFA: 'Developed Intl', EEM: 'Emerging Mkts',
    '^FTSE': 'FTSE 100', '^GDAXI': 'DAX', '^N225': 'Nikkei 225', 'GC=F': 'Gold',
    '^GSPC': 'S&P 500', '^NDX': 'Nasdaq 100', '^DJI': 'Dow Jones', '^RUT': 'Russell 2000',
    'DX-Y.NYB': 'US Dollar Index',
    'EURUSD=X': 'EUR / USD', 'GBPUSD=X': 'GBP / USD', 'USDJPY=X': 'USD / JPY',
    'AUDUSD=X': 'AUD / USD', 'NZDUSD=X': 'NZD / USD', 'USDCAD=X': 'USD / CAD',
    'USDCHF=X': 'USD / CHF', 'USDCNY=X': 'USD / CNY',
  };

  // If a user manually adds an ETF ticker (SPY etc.) via the + button, still
  // send them to the real index page on click — same mapping used for the
  // v3->v4 swap above.
  const INDEX_OF = SWAP;

  let quotes = {};

  function symbols() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      if (Array.isArray(saved)) return saved;
    } catch {}
    return DEFAULTS.slice();
  }
  function saveSymbols(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  // One-time upgrade: append newly-added default indices (FTSE/DAX/Nikkei) to
  // an existing saved strip, and (v4) swap any ETF proxy still saved from
  // before for the real index/spot symbol it tracked — without disturbing
  // the user's own additions or their position in the list.
  (function migrate() {
    if (localStorage.getItem(VER_KEY) === VERSION) return;
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      if (Array.isArray(saved)) {
        const swapped = saved.map((s) => SWAP[s] && !saved.includes(SWAP[s]) ? SWAP[s] : s);
        const add = ADDED.filter((s) => !swapped.includes(s));
        saveSymbols([...swapped, ...add]);
      }
    } catch {}
    localStorage.setItem(VER_KEY, VERSION);
  })();

  const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const label = (s) => NAMES[s] || s;
  const isFx = (s) => s.endsWith('=X');
  const isLevel = (s) => /[.=^]/.test(s); // index/FX/commodity — a level, not a $ price

  // Price cell: $ for stocks/ETFs, plain level for indices, 4dp for FX rates.
  function priceText(s, q) {
    if (!q) return '—';
    const p = Number(q.price);
    if (isFx(s)) return p.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    if (isLevel(s)) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return money(p);
  }

  function changeText(q, s) {
    if (!q) return { cls: '', text: '—' };
    const chg = (q.price ?? 0) - (q.prevClose ?? 0);
    const pct = q.day ?? 0;
    const cls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
    const sign = chg >= 0 ? '+' : '−';
    const dec = isFx(s) ? 4 : 2;
    const text = `${sign}${Math.abs(chg).toFixed(dec)} ${sign}${Math.abs(pct).toFixed(2)}%`;
    return { cls, text };
  }

  function render() {
    const list = symbols();
    const itemsHtml = list
      .map((s) => {
        const q = quotes[s];
        const c = changeText(q, s);
        return `<div class="tk-item" data-sym="${s}">
          <button class="tk-x" data-del="${s}" title="Remove" aria-label="Remove ${label(s)}">×</button>
          <span class="tk-name">${label(s)}${INDEX_OF[s] ? ` <span class="tk-sym">· ${s} ETF</span>` : ''}</span>
          <span class="tk-price">${priceText(s, q)}</span>
          <span class="tk-chg ${c.cls}">${c.text}</span>
        </div>`;
      })
      .join('');
    // The list is duplicated back-to-back so the auto-scroll loop (below) can
    // wrap from the end of the first copy to the start of the second — which
    // looks identical to the content just continuing — then silently reset
    // scrollLeft, instead of a visible snap back to the start.
    el.innerHTML = itemsHtml + itemsHtml + `<button class="tk-add" id="tk-add" title="Add a US ticker" aria-label="Add ticker">+</button>`;
    measureLoopWidth(list.length);
  }

  // Distance (px) from the start of the first copy to the start of the
  // second — i.e. exactly one full loop. Read after render() so the browser
  // has laid out the (now-duplicated) items.
  let loopWidth = 0;
  function measureLoopWidth(count) {
    const second = el.children[count];
    loopWidth = second ? second.offsetLeft : 0;
  }

  // Slow, continuous auto-scroll, pausing whenever the user is actually
  // interacting with the strip (hover, touch, manual scroll/trackpad) so it
  // never fights a deliberate scroll — resumes a couple seconds after they
  // let go. Respects prefers-reduced-motion by just not animating at all;
  // the strip stays manually scrollable either way.
  const SCROLL_SPEED = 0.35; // px per frame, ~ one full loop over a couple of minutes
  let paused = false;
  let resumeTimer;
  function pauseAutoScroll() {
    paused = true;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { paused = false; }, 2000);
  }
  // mouseenter/mouseleave and wheel/touchstart alone are enough to tell
  // "user is interacting" from "auto-scroll is moving it" — no need to also
  // listen for our own scroll events (that would race: scroll fires async,
  // after the same-tick flag flip that was meant to guard it).
  el.addEventListener('mouseenter', () => { paused = true; });
  el.addEventListener('mouseleave', () => { paused = false; });
  el.addEventListener('wheel', pauseAutoScroll, { passive: true });
  el.addEventListener('touchstart', pauseAutoScroll, { passive: true });
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    (function tick() {
      if (!paused && loopWidth > 0) {
        el.scrollLeft += SCROLL_SPEED;
        if (el.scrollLeft >= loopWidth) el.scrollLeft -= loopWidth; // seamless: content is duplicated
      }
      requestAnimationFrame(tick);
    })();
  }

  async function poll() {
    const list = symbols();
    if (!list.length) { quotes = {}; render(); return; }
    try {
      const r = await fetch('/api/ticker?symbols=' + encodeURIComponent(list.join(',')));
      const d = await r.json();
      quotes = d.quotes || {};
    } catch {
      // keep last values on a transient failure
    }
    render();
  }

  el.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      saveSymbols(symbols().filter((s) => s !== del.dataset.del));
      poll();
      return;
    }
    const item = e.target.closest('.tk-item');
    if (item && window.StockPage) {
      const sym = item.dataset.sym;
      const idx = INDEX_OF[sym];
      if (idx) window.StockPage.show(idx, { name: label(sym), isIndex: true }); // ETF proxy -> real index
      else if (isLevel(sym)) window.StockPage.show(sym, { name: label(sym), isIndex: true }); // index / FX / commodity
      else window.StockPage.show(sym); // a plain ticker the user added
      return;
    }
    if (e.target.closest('#tk-add')) {
      const input = prompt('Add a US ticker or index ETF (e.g. SPY, QQQ, AAPL):');
      if (!input) return;
      const sym = input.trim().toUpperCase();
      if (!sym) return;
      const list = symbols();
      if (!list.includes(sym)) { list.push(sym); saveSymbols(list); }
      poll();
    }
  });

  render();
  poll();
  setInterval(poll, 15000);
})();
