// prices.js — the single seam for live market data.
//
// Right now prices are entered by hand and stored on each position.
// When you're ready for live data, implement fetchQuotes() to call a
// real API (Finnhub, Alpha Vantage, Yahoo, a proxy you control, etc.)
// and return the same shape. Nothing else in the app needs to change.

const Prices = {
  // Whether live fetching is wired up. Flip to true once fetchQuotes works.
  live: false,

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
    if (!this.live) {
      throw new Error('Live prices not configured yet');
    }
    // Example shape for when you implement it:
    //
    // const key = 'YOUR_API_KEY';
    // const out = {};
    // for (const t of tickers) {
    //   const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${t}&token=${key}`);
    //   const q = await r.json();
    //   out[t] = { price: q.c, day: q.dp };
    // }
    // return out;
    return {};
  },
};
