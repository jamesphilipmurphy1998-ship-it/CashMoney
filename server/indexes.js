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

const SOURCES = [
  { tag: 'S&P 500', cache: 'index-sp500.json', url: 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv', parse: parseSP },
  { tag: 'Nasdaq 100', cache: 'index-ndx.json', url: 'https://en.wikipedia.org/wiki/Nasdaq-100', parse: parseNDX },
  { tag: 'Dow 30', cache: 'index-dow.json', url: 'https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average', parse: parseDOW },
];

// Returns [{ tag, members: { SYM: { n, sec? } } }] — fresh where possible,
// cached where not.
async function fetchMemberships() {
  const result = [];
  for (const s of SOURCES) {
    let members = null;
    try {
      members = s.parse(await fetchText(s.url));
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
