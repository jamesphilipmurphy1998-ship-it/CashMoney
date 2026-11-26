// yahoo-news.js — news stories and press releases for a stock, via Yahoo's
// public search endpoint (no cookie/crumb auth needed, unlike
// yahoo-financials.js).
//
// Deliberately NOT persisted or merged like Financials/Analysis — every call
// is a fresh on-demand fetch, and whatever Yahoo returns right now is exactly
// what's shown. A story that's aged out of Yahoo's own top results just isn't
// shown anymore; nothing accumulates on disk. That's the whole point: 1 in,
// 1 out, no history to maintain — same for both News and Press releases.

const UA = 'Mozilla/5.0 (X11; Linux x86_64)';
let ok = 0;
let fail = 0;
let lastErr = '';

// Short in-memory cache, keyed by symbol — the Home page's "Your holdings —
// news" (see home.js) fetches every holding's news on every single page
// load/refresh, which used to mean N live Yahoo calls from scratch every
// time. News doesn't change second-to-second, so a few minutes of staleness
// is an easy trade for not re-fetching identical results on every reload.
// Also collapses concurrent in-flight requests for the same symbol (e.g. two
// browser tabs opening Home at once) into a single upstream call.
const CACHE_MS = 3 * 60 * 1000;
const cache = new Map(); // symbol -> { at, promise }
function fetchRawCached(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = fetchRaw(sym).catch((e) => { cache.delete(sym); throw e; });
  cache.set(sym, { at: Date.now(), promise });
  return promise;
}

// Yahoo's search endpoint doesn't separate "press release" from "news
// article" with its own field — the site's own Press releases sub-tab is
// really just filtering by which wire service published it. Same heuristic
// here: these publishers are syndication wires companies issue their own
// releases through, everything else counts as ordinary news coverage.
const WIRE_PUBLISHERS = /pr newswire|globenewswire|business ?wire|accesswire|prweb/i;

async function fetchRaw(symbol) {
  const sym = String(symbol || '').toUpperCase();
  // Ask for more than we need since Press releases filters down from this
  // same pool — Yahoo caps the real result count at 10 regardless.
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=0&newsCount=20`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('yahoo search ' + r.status);
  const body = await r.json();
  ok++;
  return (body?.news || []).map((n) => {
    // Yahoo gives several resolutions per thumbnail. '140x140' is a
    // separately square-cropped version, not just a smaller copy of
    // 'original' — it can cut off part of the source image (e.g. a wide
    // logo banner cropped down to a square, losing text off one side).
    // 'original' keeps the article's real aspect ratio; the home page's
    // hero card (see home.js) sizes it down naturally without cropping, and
    // the stock page's small News-tab thumbnail already crops via CSS
    // (object-fit: cover) regardless of source size.
    const pics = n.thumbnail?.resolutions || [];
    const pic = pics.find((p) => p.tag === 'original') || pics[0];
    return {
      title: n.title || '',
      link: n.link || '',
      publisher: n.publisher || '',
      // providerPublishTime arrives in seconds, like everywhere else in Yahoo's API.
      time: n.providerPublishTime ? n.providerPublishTime * 1000 : null,
      image: pic?.url || null,
      // Just the symbols — not enriching each with a live % change here;
      // that'd mean a quote lookup per related ticker per story on every
      // tab open, well beyond "fetch today's top stories."
      relatedTickers: n.relatedTickers || [],
    };
  });
}

async function getNews(symbol) {
  try {
    return (await fetchRawCached(symbol)).slice(0, 8);
  } catch (e) {
    fail++;
    lastErr = String(e.message || e);
    throw e;
  }
}

async function getPressReleases(symbol) {
  try {
    const all = await fetchRawCached(symbol);
    return all.filter((n) => WIRE_PUBLISHERS.test(n.publisher)).slice(0, 4);
  } catch (e) {
    fail++;
    lastErr = String(e.message || e);
    throw e;
  }
}

module.exports = { getNews, getPressReleases, status: () => ({ ok, fail, lastErr }) };
