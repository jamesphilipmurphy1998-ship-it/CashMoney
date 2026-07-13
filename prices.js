// prices.js — the single seam for live market data.
//
// Right now prices are entered by hand and stored on each position.
// When you're ready for live data, implement fetchQuotes() to call a
// real API (Finnhub, Alpha Vantage, Yahoo, a proxy you control, etc.)
// and return the same shape. Nothing else in the app needs to change.

// Currency-aware price formatter. International listings quote in their home
// currency — .T Tokyo (yen), .L London (pence), .DE Frankfurt (euros) — while
// index levels and FX rates are unitless. US symbols stay $.
function fmtMoney(sym, n) {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n);
  const fmt = (d) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const s = String(sym || '');
  if (/\.T$/.test(s)) return '¥' + fmt(0);
  if (/\.L$/.test(s)) return fmt(2) + 'p';
  if (/\.(DE|F)$/.test(s)) return '€' + fmt(2);
  if (/\.NZ$/.test(s)) return 'NZ$' + fmt(2); // NZX listings + Sharesies cash/KiwiSaver imports — NZD, not USD
  if (/\.AX$/.test(s)) return 'A$' + fmt(2);
  if (/=X$/.test(s)) return fmt(4); // FX rate
  if (/^\^/.test(s) || /=F$/.test(s) || /\.NYB$/.test(s)) return fmt(2); // index / futures level
  return '$' + fmt(2);
}
window.fmtMoney = fmtMoney;

// ── Currency conversion ──────────────────────────────────────────────────
// Holdings quote in their listing's home currency (USD, JPY for .T, pence for
// .L, EUR for .DE). To total a mixed-currency portfolio we convert everything
// through USD using live Yahoo FX pairs, then into the user's chosen display
// currency. Rates load from /api/peek (read-only) and refresh periodically.
const Currency = (() => {
  // code -> [yahoo pair, inverted?]. Direct pairs are "USD per unit"; inverted
  // pairs quote "units per USD", so usdPer = 1/rate.
  const PAIRS = {
    EUR: ['EURUSD=X', false], GBP: ['GBPUSD=X', false], AUD: ['AUDUSD=X', false], NZD: ['NZDUSD=X', false],
    JPY: ['USDJPY=X', true], CAD: ['USDCAD=X', true], CHF: ['USDCHF=X', true], CNY: ['USDCNY=X', true],
  };
  // Currencies the user can display totals in.
  const OPTIONS = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'CNY'];
  const usd = { USD: 1 }; // usdPer[code] = value of 1 unit in USD

  // Native currency of a symbol from its Yahoo suffix. GBX = London pence.
  function of(sym) {
    const s = String(sym || '');
    if (/\.T$/.test(s)) return 'JPY';
    if (/\.L$/.test(s)) return 'GBX';
    if (/\.(DE|F|PA|AS|MI)$/.test(s)) return 'EUR';
    if (/\.NZ$/.test(s)) return 'NZD'; // NZX listings, and Sharesies cash/KiwiSaver imports (see sharesies.js)
    if (/\.AX$/.test(s)) return 'AUD';
    return 'USD';
  }
  function usdPer(code) {
    if (code === 'GBX') return usd.GBP != null ? usd.GBP * 0.01 : null; // pence
    return usd[code] != null ? usd[code] : null;
  }
  function convert(amount, from, to) {
    if (amount == null || isNaN(amount)) return amount;
    if (from === to) return amount;
    const uf = usdPer(from);
    const ut = usdPer(to);
    if (uf == null || ut == null) return amount; // rates not loaded yet — show raw
    return amount * uf / ut;
  }
  function format(code, n, decimals) {
    if (n == null || isNaN(n)) return '—';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
    } catch {
      return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + ' ' + code;
    }
  }
  async function loadRates() {
    const pairs = Object.values(PAIRS).map((p) => p[0]);
    try {
      const q = ((await (await fetch('/api/peek?symbols=' + encodeURIComponent(pairs.join(',')))).json()).quotes) || {};
      for (const [code, [pair, inverted]] of Object.entries(PAIRS)) {
        const r = q[pair] && q[pair].price;
        if (r) usd[code] = inverted ? 1 / r : r;
      }
    } catch {}
    return usd;
  }
  // Display currency is per-portfolio: a map of { portfolioId -> currency }.
  // `scope` tracks which portfolio is being viewed. A portfolio with no saved
  // choice falls back to the legacy global setting (if any) or USD.
  const MAP_KEY = 'cashmoney.displayCcyByPf';
  const legacy = localStorage.getItem('cashmoney.displayCcy') || 'USD';
  let byPf;
  try { byPf = JSON.parse(localStorage.getItem(MAP_KEY)) || {}; } catch { byPf = {}; }
  let scope = '__global__';
  return {
    OPTIONS, of, usdPer, convert, format, loadRates,
    setScope(pid) { scope = pid || '__global__'; },
    get display() { return byPf[scope] || legacy; },
    set display(c) { byPf[scope] = c; localStorage.setItem(MAP_KEY, JSON.stringify(byPf)); },
    ready: () => usd.EUR != null,
  };
})();
window.Currency = Currency;

const Prices = {
  // Live fetching goes through our own backend (/api/quotes). Requesting
  // specific symbols also promotes them to the Finnhub hot set server-side,
  // so portfolio holdings refresh constantly.
  live: true,

  // A user's own pasted Finnhub key (Connectors page — see store.js's
  // getFinnhubKey/saveFinnhubKey), set by app.js after loading it from
  // Supabase. When present, fetchQuotes attaches it (and this user's auth
  // token) so the server gives these symbols their own dedicated 60/min
  // budget instead of sharing the app's one server-wide key — see
  // registerPersonalKey in server/quotes.js.
  finnhubKey: '',

  // Read a position's current price. With manual data this is just the
  // value the user typed; with live data, app.js overwrites pos.price
  // from fetchQuotes() before calling this.
  getPrice(pos) {
    return Number(pos.price) || 0;
  },

  getDayChange(pos) {
    return Number(pos.day) || 0; // percent
  },

  // Live-data stub. Given ['AAPL','NVDA'], resolve to:
  //   { AAPL: { price: 214.1, day: 0.6 }, NVDA: { price: 172.4, day: 2.8 } }
  // Throws by default so the caller keeps using manual values.
  async fetchQuotes(tickers) {
    if (!this.live || !tickers.length) return {};
    let url = '/api/quotes?symbols=' + encodeURIComponent(tickers.join(','));
    const opts = {};
    // finnhubKey= is sent even when empty (cleared) so the server knows to
    // stop this user's personal loop, not just when one is actively set.
    if (this.finnhubKey || this._hadFinnhubKey) {
      url += '&finnhubKey=' + encodeURIComponent(this.finnhubKey || '');
      this._hadFinnhubKey = !!this.finnhubKey;
      if (window.sb) {
        const { data } = await window.sb.auth.getSession();
        const token = data?.session?.access_token || '';
        opts.headers = { Authorization: `Bearer ${token}` };
      }
    }
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('quotes ' + r.status);
    const d = await r.json();
    const out = {};
    for (const t of tickers) {
      const q = (d.quotes || {})[t.toUpperCase()];
      if (q) out[t] = { price: q.price, day: q.day };
    }
    return out;
  },
};
