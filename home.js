// home.js — the market Home page (indices, currencies, biggest movers).
//
// Opened from the rail "Home" button and the brand logo. Unlike the portfolio
// summary, this shows no holdings — just a market overview, all priced through
// the Yahoo/Finnhub cache. Overlay page like stock.js / connectors.

(() => {
  const $ = (s) => document.querySelector(s);
  const page = $('#home-page');
  if (!page) return;

  const INDICES = [
    ['^GSPC', 'S&P 500'], ['^NDX', 'Nasdaq 100'], ['^DJI', 'Dow Jones'], ['^RUT', 'Russell 2000'],
    ['^FTSE', 'FTSE 100'], ['^GDAXI', 'DAX'], ['^N225', 'Nikkei 225'],
  ];
  const CURRENCIES = [
    ['EURUSD=X', 'EUR / USD'], ['GBPUSD=X', 'GBP / USD'], ['USDJPY=X', 'USD / JPY'], ['AUDUSD=X', 'AUD / USD'],
    ['NZDUSD=X', 'NZD / USD'], ['USDCAD=X', 'USD / CAD'], ['USDCHF=X', 'USD / CHF'], ['USDCNY=X', 'USD / CNY'],
  ];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pctTxt = (d) => (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2) + '%';
  const cls = (d) => (d > 0 ? 'up' : d < 0 ? 'down' : '');
  const price = (s, q) => (q ? window.fmtMoney(s, q.price) : '—');

  async function peek(syms) {
    try {
      return ((await (await fetch('/api/peek?symbols=' + encodeURIComponent(syms.join(',')))).json()).quotes) || {};
    } catch { return {}; }
  }

  function card(sym, label, q, name) {
    const d = q ? q.day : null;
    return `<button class="hm-card" data-sym="${esc(sym)}"${name ? ` data-name="${esc(name)}"` : ''}>
      <span class="hm-card-name">${esc(label)}</span>
      <span class="hm-card-price">${price(sym, q)}</span>
      <span class="hm-card-chg ${d == null ? '' : cls(d)}">${d == null ? '' : pctTxt(d)}</span>
    </button>`;
  }

  async function renderMarkets() {
    const q = await peek([...INDICES, ...CURRENCIES].map((x) => x[0]));
    $('#hm-indices').innerHTML = INDICES.map(([s, l]) => card(s, l, q[s], l)).join('');
    $('#hm-currencies').innerHTML = CURRENCIES.map(([s, l]) => card(s, l, q[s], l)).join('');
  }

  function moverRow(x) {
    return `<button class="hm-mover" data-sym="${esc(x.s)}">
      <span class="hm-mover-sym">${esc(x.s)}<span class="hm-mover-name">${esc(x.n)}</span></span>
      <span class="hm-mover-price">${window.fmtMoney(x.s, x.price)}</span>
      <span class="hm-mover-chg ${cls(x.d)}">${pctTxt(x.d)}</span>
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

  async function renderMovers() {
    let d = { gainers: [], losers: [] };
    try { d = await (await fetch('/api/movers')).json(); } catch {}
    const g = named(d.gainers || []);
    const l = named(d.losers || []);
    $('#hm-gainers').innerHTML = g.map(moverRow).join('') || '<p class="muted hm-none">No data yet.</p>';
    $('#hm-losers').innerHTML = l.map(moverRow).join('') || '<p class="muted hm-none">No data yet.</p>';
  }

  function refresh() {
    renderMarkets();
    renderMovers();
  }

  let timer = null;
  function show() {
    if (window.StockPage) StockPage.close();
    if (window.ConnectorsPage) ConnectorsPage.close();
    if (window.ProfilePage) ProfilePage.close();
    if (window.ResearchPage) ResearchPage.close();
    if (window.CompoundPage) CompoundPage.close();
    document.body.classList.add('home-open');
    page.hidden = false;
    window.scrollTo(0, 0);
    refresh();
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
    const sym = el.dataset.sym;
    const name = el.dataset.name;
    if (name) StockPage.show(sym, { name, isIndex: true }); // index / fx card
    else StockPage.show(sym); // a mover stock
  });

  window.HomePage = { show, close };
})();
