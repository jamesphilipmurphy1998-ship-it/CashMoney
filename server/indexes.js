// indexes.js — index membership sources for the stock tags.
//
// Finnhub's free tier doesn't expose index constituents, so membership for
// each index is pulled from its own maintained source and matched against the
// symbol universe. Each fetch is cached to data/index-*.json; if a source is
// ever unreachable, the last-known list is reused so tags never break.
//
// To add an index later (e.g. Dow 30), add a SOURCE with a parser.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

// Minimal CSV line splitter that respects double-quoted fields.
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// S&P 500: public datasets CSV (Symbol, Security, GICS Sector, …)
function parseSP(csv) {
  const out = {};
  const lines = csv.split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const c = splitCsv(line);
    const sym = (c[0] || '').trim();
    if (sym) out[sym] = { n: (c[1] || '').trim(), sec: (c[2] || '').trim() };
  }
  if (Object.keys(out).length < 400) throw new Error('S&P parse too few rows');
  return out;
}

// Nasdaq-100: Wikipedia constituents table (Ticker, Company, …)
function parseNDX(html) {
  const table = (html.match(/id="constituents"[\s\S]*?<\/table>/) || [])[0];
  if (!table) throw new Error('Nasdaq-100 table not found');
  const out = {};
  for (const [, row] of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length >= 2 && /^[A-Z]{1,6}([.\-][A-Z])?$/.test(cells[0])) {
      out[cells[0]] = { n: cells[1] };
    }
  }
  if (Object.keys(out).length < 80) throw new Error('Nasdaq-100 parse too few rows');
  return out;
}

// Dow 30: Wikipedia components table (Company, Exchange, Symbol, …) — the
// ticker column isn't first, so detect it from the header row.
function parseDOW(html) {
  const tables = html.match(/<table[^>]*>[\s\S]*?<\/table>/g) || [];
  for (const t of tables) {
    const hdr = [...t.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim().toLowerCase());
    const si = hdr.findIndex((h) => h.startsWith('symbol'));
    const ci = hdr.findIndex((h) => h.startsWith('company'));
    if (si < 0 || ci < 0) continue;
    const out = {};
    for (const [, row] of t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim());
      if (cells.length > Math.max(si, ci) && /^[A-Z]{1,6}$/.test(cells[si])) out[cells[si]] = { n: cells[ci] };
    }
    if (Object.keys(out).length >= 25) return out;
  }
  throw new Error('Dow 30 table not found');
}

// Russell 2000: Vanguard's VTWO (Russell 2000 ETF) holdings API — paginated
// JSON, 500 per page, ~1,940 stocks. (iShares' IWM CSV is bot-walled.)
async function fetchR2K() {
  const base = 'https://investor.vanguard.com/investment-products/etfs/profile/api/VTWO/portfolio-holding/stock';
  const headers = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
  const out = {};
  for (let start = 1; ; start += 500) {
    const r = await fetch(`${base}?start=${start}&count=500`, { headers });
    if (!r.ok) throw new Error(`vanguard ${r.status}`);
    const d = await r.json();
    const entity = (d.fund && d.fund.entity) || [];
    for (const e of entity) {
      const sym = (e.ticker || '').trim();
      if (/^[A-Z]{1,6}([.\-][A-Z])?$/.test(sym)) out[sym] = { n: e.longName || sym };
    }
    if (!entity.length || start + 500 > (d.size || 0)) break;
  }
  if (Object.keys(out).length < 1200) throw new Error('Russell 2000 too few rows');
  return out;
}

// Generic Wikipedia constituents-table parser: finds the table whose header
// has a recognisable ticker column, maps each ticker through mapSym (which
// also applies the Yahoo exchange suffix for non-US listings).
function parseWikiTable(html, { symHeads, nameHeads, min, mapSym }) {
  const tables = html.match(/<table[^>]*>[\s\S]*?<\/table>/g) || [];
  for (const t of tables) {
    const hdr = [...t.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim().toLowerCase());
    const si = hdr.findIndex((h) => symHeads.some((k) => h.startsWith(k)));
    const ci = hdr.findIndex((h) => nameHeads.some((k) => h.startsWith(k)));
    if (si < 0) continue;
    const out = {};
    for (const [, row] of t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim());
      if (cells.length <= si || !cells[si]) continue;
      if (/^(TICKER|SYMBOL|EPIC)$/i.test(cells[si])) continue; // header row rendered as <td>
      const sym = mapSym(cells[si].toUpperCase());
      if (sym) out[sym] = { n: ci >= 0 && cells[ci] ? cells[ci] : sym };
    }
    if (Object.keys(out).length >= min) return out;
  }
  throw new Error('constituents table not found');
}

// LSE tickers on Yahoo: dots become dashes, then ".L" (BT.A -> BT-A.L).
const ftseSym = (raw) => (/^[A-Z]{2,5}(\.[A-Z])?$/.test(raw) ? raw.replace('.', '-') + '.L' : null);
// XETRA tickers on Yahoo end ".DE"; Wikipedia sometimes includes the suffix.
const daxSym = (raw) => {
  const s = raw.endsWith('.DE') ? raw : raw + '.DE';
  return /^[A-Z0-9]{2,6}\.DE$/.test(s) ? s : null;
};

// Nikkei 225: Wikipedia lists components as "Company (TYO: 7203)", where the
// 4-digit TSE code sits in a link right after the "TYO" anchor. Yahoo symbol
// is the code plus ".T". Company name = the last wiki-link title before "TYO"
// (skipping the Tokyo Stock Exchange link itself).
function parseNikkei(html) {
  const out = {};
  const parts = html.split(/>TYO<\/a>/);
  for (let i = 1; i < parts.length; i++) {
    const code = (parts[i].slice(0, 400).match(/topSearchStr=(\d{4})/) || parts[i].slice(0, 400).match(/>(\d{4})</) || [])[1];
    if (!code) continue;
    const titles = [...parts[i - 1].matchAll(/title="([^"]+)"/g)].map((m) => m[1]).filter((t) => t !== 'Tokyo Stock Exchange');
    out[code + '.T'] = { n: titles.length ? titles[titles.length - 1] : code + '.T' };
  }
  if (Object.keys(out).length < 150) throw new Error('Nikkei 225 parse too few rows');
  return out;
}

const SOURCES = [
  { tag: 'S&P 500', cache: 'index-sp500.json', url: 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv', parse: parseSP },
  { tag: 'Nasdaq 100', cache: 'index-ndx.json', url: 'https://en.wikipedia.org/wiki/Nasdaq-100', parse: parseNDX },
  { tag: 'Dow 30', cache: 'index-dow.json', url: 'https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average', parse: parseDOW },
  { tag: 'Russell 2000', cache: 'index-r2k.json', fetch: fetchR2K },
  { tag: 'FTSE 100', cache: 'index-ftse.json', url: 'https://en.wikipedia.org/wiki/FTSE_100_Index', parse: (h) => parseWikiTable(h, { symHeads: ['epic', 'ticker'], nameHeads: ['company'], min: 90, mapSym: ftseSym }) },
  { tag: 'DAX', cache: 'index-dax.json', url: 'https://en.wikipedia.org/wiki/DAX', parse: (h) => parseWikiTable(h, { symHeads: ['ticker', 'symbol'], nameHeads: ['company'], min: 35, mapSym: daxSym }) },
  { tag: 'Nikkei 225', cache: 'index-nikkei.json', url: 'https://en.wikipedia.org/wiki/Nikkei_225', parse: parseNikkei },
];

// Returns [{ tag, members: { SYM: { n, sec? } } }] — fresh where possible,
// cached where not.
async function fetchMemberships() {
  const result = [];
  for (const s of SOURCES) {
    let members = null;
    try {
      members = s.fetch ? await s.fetch() : s.parse(await fetchText(s.url));
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(path.join(DATA, s.cache), JSON.stringify(members));
      console.log('[index]', s.tag, '— fetched', Object.keys(members).length, 'members');
    } catch (e) {
      try {
        members = JSON.parse(fs.readFileSync(path.join(DATA, s.cache), 'utf8'));
        console.warn('[index]', s.tag, '— fetch failed (', e.message, ') — using cached', Object.keys(members).length);
      } catch {
        members = {};
        console.warn('[index]', s.tag, '— no data available');
      }
    }
    result.push({ tag: s.tag, members });
  }
  return result;
}

module.exports = { fetchMemberships };
