// yahoo-financials.js — Yahoo's authenticated financial-statements API
// (income statement, balance sheet, cash flow — annual + quarterly).
//
// A separate connector from yahoo.js, not folded into it:
//  - Auth is different: yahoo.js's quote sweep is a bare fetch, no cookies.
//    This needs a session cookie + "crumb" anti-scraping token first.
//  - Usage is different: quotes are swept continuously; statements don't
//    change intraday, so results are cached for a day and fetched on demand
//    (only when a stock's Financials tab is actually opened), never swept.
//  - Failure mode is different: an expired crumb needs refreshing, not the
//    same rate-limit backoff yahoo.js's sweep handles.
//
// The old quoteSummary "*History" modules (incomeStatementHistory etc.) are
// mostly deprecated by Yahoo now — tested directly, balance sheet came back
// with nothing but dates, cash flow with only netIncome. The modern
// replacement Yahoo's own site actually uses is "fundamentals-timeseries",
// which takes an explicit list of metric codes (e.g. annualTotalRevenue) and
// returns one series per metric Yahoo actually has data for — anything
// unresolvable is just silently omitted, not an error.

const UA = 'Mozilla/5.0 (X11; Linux x86_64)';

let cookie = null;
let crumb = null;
let ok = 0;
let fail = 0;
let lastErr = '';
let lastTs = 0;

async function refreshCrumb() {
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
  const setCookie = r1.headers.getSetCookie?.() || r1.headers.get('set-cookie');
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  cookie = list.map((c) => c.split(';')[0]).join('; ');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  if (!r2.ok) throw new Error('crumb fetch failed (' + r2.status + ')');
  const text = (await r2.text()).trim();
  if (!text || text.includes('<html')) throw new Error('crumb looked invalid');
  crumb = text;
}

// Metric codes per statement — prefixed with "annual"/"quarterly" at request
// time. Not every company reports every one of these; Yahoo just omits
// whatever it doesn't have, so an over-broad list here is harmless.
const METRICS = {
  income: [
    'TotalRevenue', 'CostOfRevenue', 'GrossProfit', 'ResearchAndDevelopment',
    'SellingGeneralAndAdministration', 'OperatingExpense', 'OperatingIncome',
    'NetNonOperatingInterestIncomeExpense', 'OtherIncomeExpense', 'PretaxIncome',
    'TaxProvision', 'NetIncomeCommonStockholders', 'DilutedEPS', 'BasicEPS', 'EBITDA',
    'DilutedAverageShares', // used to turn an EPS estimate into an approximate $ net-income projection for the Revenue-vs-Earnings chart
  ],
  balance: [
    'TotalAssets', 'CurrentAssets', 'CashAndCashEquivalents', 'TotalLiabilitiesNetMinorityInterest',
    'CurrentLiabilities', 'TotalEquityGrossMinorityInterest', 'StockholdersEquity',
    'RetainedEarnings', 'LongTermDebt', 'TotalDebt',
  ],
  cashflow: [
    'OperatingCashFlow', 'InvestingCashFlow', 'FinancingCashFlow', 'CapitalExpenditure',
    'FreeCashFlow', 'EndCashPosition', 'NetIncome', 'DepreciationAndAmortization',
    'RepurchaseOfCapitalStock', 'CashDividendsPaid',
  ],
};

function humanize(metric) {
  return metric.replace(/([A-Z])/g, ' $1').trim();
}

// A period-end date like "2025-09-30" -> "Q3 2025" — calendar-quarter
// approximation (most companies' fiscal quarters line up with these, and
// Yahoo doesn't tell us a company's actual fiscal-year-end offset). Good
// enough to label *which* reporting period a column is, which is really the
// point — the exact date underneath is what actually dedupes/merges below.
function quarterLabel(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

// One call per (statement, period) pair — e.g. all annual income-statement
// metrics in one request. Returns { dates, quarters, rows: [{key,label,values}] },
// dates oldest-first; each row only as long as that metric actually has data.
async function fetchTable(symbol, metrics, period) {
  const types = metrics.map((m) => period + m).join(',');
  const period1 = 493590046; // 1985-08-01 — comfortably before any real listing
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
    `?symbol=${encodeURIComponent(symbol)}&type=${types}&period1=${period1}&period2=${period2}&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookie } });
  if (r.status === 401) throw Object.assign(new Error('crumb expired'), { crumbExpired: true });
  if (!r.ok) throw new Error('fundamentals-timeseries ' + r.status);
  const body = await r.json();
  if (body?.timeseries?.error) throw new Error(body.timeseries.error.description || 'timeseries error');
  const results = body?.timeseries?.result || [];

  // Union of dates across every metric that came back, oldest first.
  const dateSet = new Set();
  for (const res of results) {
    const key = res.meta?.type?.[0];
    for (const point of res[key] || []) if (point?.asOfDate) dateSet.add(point.asOfDate);
  }
  const dates = [...dateSet].sort();
  if (!dates.length) return null;

  const rows = [];
  for (const metric of metrics) {
    const key = period + metric;
    const res = results.find((x) => x.meta?.type?.[0] === key);
    if (!res) continue;
    const byDate = new Map((res[key] || []).filter(Boolean).map((p) => [p.asOfDate, p.reportedValue?.raw]));
    rows.push({ key: metric, label: humanize(metric), values: dates.map((d) => (byDate.has(d) ? byDate.get(d) : null)) });
  }
  return { dates, quarters: dates.map(quarterLabel), rows };
}

// Folds a freshly-fetched table into whatever's already on disk, by date —
// so a period Yahoo stops returning (it only ever exposes a rolling window)
// stays in our copy forever, while any new period gets added. Existing dates
// get their values refreshed (covers Yahoo revising a recent quarter); the
// underlying date is the real identity, quarters is just its display label.
function mergeTable(oldTable, newTable) {
  if (!oldTable) return newTable;
  if (!newTable) return oldTable;
  const dates = [...new Set([...oldTable.dates, ...newTable.dates])].sort();
  const rowsByKey = new Map();
  for (const r of oldTable.rows) {
    const byDate = new Map(oldTable.dates.map((d, i) => [d, r.values[i]]));
    rowsByKey.set(r.key, { key: r.key, label: r.label, byDate });
  }
  for (const r of newTable.rows) {
    const existing = rowsByKey.get(r.key) || { key: r.key, label: r.label, byDate: new Map() };
    newTable.dates.forEach((d, i) => existing.byDate.set(d, r.values[i]));
    existing.label = r.label;
    rowsByKey.set(r.key, existing);
  }
  const rows = [...rowsByKey.values()].map((r) => ({ key: r.key, label: r.label, values: dates.map((d) => (r.byDate.has(d) ? r.byDate.get(d) : null)) }));
  return { dates, quarters: dates.map(quarterLabel), rows };
}
function mergeFinancials(oldData, newData) {
  if (!oldData) return newData;
  const merged = {};
  for (const stmt of ['income', 'balance', 'cashflow']) {
    merged[stmt] = {
      annual: mergeTable(oldData[stmt]?.annual, newData[stmt]?.annual),
      quarterly: mergeTable(oldData[stmt]?.quarterly, newData[stmt]?.quarterly),
    };
  }
  return merged;
}

async function fetchStatement(symbol, statement) {
  const metrics = METRICS[statement];
  const [annual, quarterly] = await Promise.all([
    fetchTable(symbol, metrics, 'annual'),
    fetchTable(symbol, metrics, 'quarterly'),
  ]);
  return { annual, quarterly };
}

async function fetchAll(symbol) {
  const [income, balance, cashflow] = await Promise.all([
    fetchStatement(symbol, 'income'),
    fetchStatement(symbol, 'balance'),
    fetchStatement(symbol, 'cashflow'),
  ]);
  return { income, balance, cashflow };
}

// Persisted to disk (one file per symbol, same "data/<thing>/<SYM>.json"
// convention as history.js) — statements only change quarterly, so there's
// no reason a server restart should force re-fetching all ~2,800 index
// members from Yahoo again. The in-memory Map is just a hot layer on top so
// repeat requests within a process don't even touch the filesystem.
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'financials');
try { fs.mkdirSync(DIR, { recursive: true }); } catch {}

const fileFor = (sym) => path.join(DIR, sym.replace(/[^A-Za-z0-9._\-^=]/g, '_') + '.json');

function readDisk(sym, maxAgeMs) {
  try {
    const stat = fs.statSync(fileFor(sym));
    if (maxAgeMs != null && Date.now() - stat.mtimeMs > maxAgeMs) return null;
    return JSON.parse(fs.readFileSync(fileFor(sym), 'utf8'));
  } catch {
    return null;
  }
}
function writeDisk(sym, data) {
  try { fs.writeFileSync(fileFor(sym), JSON.stringify(data)); } catch {}
}

const cache = new Map(); // symbol -> { ts, data }
const CACHE_MS = 24 * 60 * 60 * 1000; // statements don't change intraday

async function getFinancials(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.data;

  const fresh = readDisk(sym, CACHE_MS);
  if (fresh) {
    cache.set(sym, { ts: Date.now(), data: fresh });
    return fresh;
  }

  try {
    if (!cookie || !crumb) await refreshCrumb();
    let data;
    try {
      data = await fetchAll(sym);
    } catch (e) {
      if (!e.crumbExpired) throw e;
      await refreshCrumb(); // expired mid-cache — refresh once and retry
      data = await fetchAll(sym);
    }
    ok++; lastTs = Date.now();
    // Merge into whatever's already on disk (any age — this is about
    // accumulating history, not freshness) so a period Yahoo no longer
    // returns stays permanently instead of being overwritten away.
    const merged = mergeFinancials(readDisk(sym, null), data);
    cache.set(sym, { ts: Date.now(), data: merged });
    writeDisk(sym, merged);
    return merged;
  } catch (e) {
    fail++; lastErr = String(e.message || e);
    if (hit) return hit.data; // serve stale in-memory copy rather than nothing
    const stale = readDisk(sym, null); // any age — better than a dead tab
    if (stale) return stale;
    throw e;
  }
}

function diskCount() {
  try { return fs.readdirSync(DIR).length; } catch { return 0; }
}

// ── Analysis: analyst price targets, recommendations, earnings/revenue
// estimates, earnings history — same connector as the financials above (same
// crumb/cookie session, same ok/fail counters), just different quoteSummary
// modules and its own disk cache. Persisted and merged the same way, so
// earnings history/estimates accumulate over time rather than being
// overwritten when Yahoo's rolling window shifts.
const ANALYSIS_DIR = path.join(__dirname, '..', 'data', 'analysis');
try { fs.mkdirSync(ANALYSIS_DIR, { recursive: true }); } catch {}
const analysisFileFor = (sym) => path.join(ANALYSIS_DIR, sym.replace(/[^A-Za-z0-9._\-^=]/g, '_') + '.json');
function readAnalysisDisk(sym, maxAgeMs) {
  try {
    const stat = fs.statSync(analysisFileFor(sym));
    if (maxAgeMs != null && Date.now() - stat.mtimeMs > maxAgeMs) return null;
    return JSON.parse(fs.readFileSync(analysisFileFor(sym), 'utf8'));
  } catch {
    return null;
  }
}
function writeAnalysisDisk(sym, data) {
  try { fs.writeFileSync(analysisFileFor(sym), JSON.stringify(data)); } catch {}
}

const ANALYSIS_MODULES = 'financialData,recommendationTrend,earningsTrend,earningsHistory';
async function fetchAnalysisRaw(symbol) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${ANALYSIS_MODULES}&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookie } });
  if (r.status === 401) throw Object.assign(new Error('crumb expired'), { crumbExpired: true });
  if (!r.ok) throw new Error('quoteSummary ' + r.status);
  const body = await r.json();
  if (body?.quoteSummary?.error) throw new Error(body.quoteSummary.error.description || 'quoteSummary error');
  return body?.quoteSummary?.result?.[0] || {};
}

// Pulls the plain value out of Yahoo's {raw, fmt} wrapper objects.
function unwrap(v) {
  if (v == null) return null;
  return typeof v === 'object' && 'raw' in v ? v.raw : v;
}

function parseAnalysis(r) {
  const fd = r.financialData || {};
  const priceTargets = {
    mean: unwrap(fd.targetMeanPrice), high: unwrap(fd.targetHighPrice), low: unwrap(fd.targetLowPrice), median: unwrap(fd.targetMedianPrice),
    recommendationKey: fd.recommendationKey || null, recommendationMean: unwrap(fd.recommendationMean),
    numberOfAnalysts: unwrap(fd.numberOfAnalystOpinions),
  };
  const recommendationTrend = (r.recommendationTrend?.trend || []).map((t) => ({
    period: t.period, strongBuy: t.strongBuy, buy: t.buy, hold: t.hold, sell: t.sell, strongSell: t.strongSell,
  }));
  const earningsEstimate = (r.earningsTrend?.trend || []).map((t) => ({
    period: t.period, endDate: t.endDate,
    epsEstimate: unwrap(t.earningsEstimate?.avg), epsLow: unwrap(t.earningsEstimate?.low), epsHigh: unwrap(t.earningsEstimate?.high),
    epsYearAgo: unwrap(t.earningsEstimate?.yearAgoEps), epsGrowth: unwrap(t.earningsEstimate?.growth ?? t.growth),
    epsNumberOfAnalysts: unwrap(t.earningsEstimate?.numberOfAnalysts),
    revenueEstimate: unwrap(t.revenueEstimate?.avg), revenueLow: unwrap(t.revenueEstimate?.low), revenueHigh: unwrap(t.revenueEstimate?.high),
    revenueYearAgo: unwrap(t.revenueEstimate?.yearAgoRevenue), revenueGrowth: unwrap(t.revenueEstimate?.growth),
    numberOfAnalysts: unwrap(t.revenueEstimate?.numberOfAnalysts),
  }));
  const earningsHistory = (r.earningsHistory?.history || []).map((h) => ({
    quarter: unwrap(h.quarter) ? new Date(unwrap(h.quarter) * 1000).toISOString().slice(0, 10) : null,
    epsActual: unwrap(h.epsActual), epsEstimate: unwrap(h.epsEstimate), surprisePercent: unwrap(h.surprisePercent),
  }));
  return { priceTargets, recommendationTrend, earningsEstimate, earningsHistory };
}

// Merge by identity key so history accumulates rather than getting
// overwritten when Yahoo's rolling window shifts — same idea as mergeTable
// above, just for arrays instead of a dates/rows table.
function mergeByKey(oldArr, newArr, keyFn) {
  const map = new Map((oldArr || []).map((x) => [keyFn(x), x]));
  for (const x of newArr || []) map.set(keyFn(x), x); // fresh data wins on overlap
  return [...map.values()];
}
function mergeAnalysis(oldData, newData) {
  if (!oldData) return newData;
  return {
    priceTargets: newData.priceTargets, // a live snapshot, not historical — always just the latest
    recommendationTrend: mergeByKey(oldData.recommendationTrend, newData.recommendationTrend, (x) => x.period),
    earningsEstimate: mergeByKey(oldData.earningsEstimate, newData.earningsEstimate, (x) => x.period + '|' + x.endDate),
    earningsHistory: mergeByKey(oldData.earningsHistory, newData.earningsHistory, (x) => x.quarter),
  };
}

const analysisCache = new Map();
async function getAnalysis(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const hit = analysisCache.get(sym);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.data;

  const fresh = readAnalysisDisk(sym, CACHE_MS);
  if (fresh) {
    analysisCache.set(sym, { ts: Date.now(), data: fresh });
    return fresh;
  }

  try {
    if (!cookie || !crumb) await refreshCrumb();
    let rawData;
    try {
      rawData = await fetchAnalysisRaw(sym);
    } catch (e) {
      if (!e.crumbExpired) throw e;
      await refreshCrumb(); // expired mid-cache — refresh once and retry
      rawData = await fetchAnalysisRaw(sym);
    }
    ok++; lastTs = Date.now();
    const parsed = parseAnalysis(rawData);
    const merged = mergeAnalysis(readAnalysisDisk(sym, null), parsed);
    analysisCache.set(sym, { ts: Date.now(), data: merged });
    writeAnalysisDisk(sym, merged);
    return merged;
  } catch (e) {
    fail++; lastErr = String(e.message || e);
    if (hit) return hit.data;
    const stale = readAnalysisDisk(sym, null);
    if (stale) return stale;
    throw e;
  }
}
function analysisDiskCount() {
  try { return fs.readdirSync(ANALYSIS_DIR).length; } catch { return 0; }
}

module.exports = {
  getFinancials,
  getAnalysis,
  status: () => ({ ok, fail, lastErr, lastTs, cached: cache.size, diskCached: diskCount(), analysisCached: analysisDiskCount(), hasCrumb: !!crumb }),
};
