// sharesies.js — one-shot holdings import from Sharesies (unofficial API).
//
// Role: NOT a live price source. Sharesies gives us the things it uniquely
// knows — which tickers you hold, how many shares, and your cost basis. Once
// those become positions in a portfolio, quotes.js/yahoo.js price them like
// any other holding. So this module only needs to log in and fetch a
// snapshot; it never runs in the background.
//
// email/password/2FA code (`pendings`) live in memory only, for the duration
// of a login attempt — never written to disk. The logged-in session
// (`sessions`: cookie + tokens, no password) is persisted to
// data/sharesies-sessions/<uid>.json so reconnecting isn't required after
// every server restart; it's still not a background poller — every sync
// is still a deliberate user action (click "Refresh" on the Connectors page).
//
// Sessions are keyed by app-user id (the Supabase auth uid, passed in from
// server.js as `uid`) — NOT a single shared global. This server can be hit
// by multiple signed-in app accounts (each with their own Google login and
// their own portfolios), and each one's Sharesies connection must stay
// isolated: user A connecting Sharesies must never expose their holdings to
// user B, even though both are talking to the same Node process. Every
// exported function takes `uid` as its first argument for this reason.
//
// `uid` is verified server-side against the real Supabase session (see
// verifyUser in server.js) before it ever reaches here — a client can't
// just claim to be a different uid.
//
// Endpoints below are reverse-engineered by capturing real traffic from
// sharesies.nz's own web app (no public docs exist). Four hosts are
// involved, each with its own token from the same login/2FA response:
//   app.sharesies.nz        — login/2FA, auth: distill_token
//   app.sharesies.nz/api/profiles — lists every product under the account
//                             (Invest, KiwiSaver, Save, Wallet), each with
//                             its own portfolio id — see getProducts()
//   data.sharesies.nz       — instrument lookup (ticker/exchange by fund id),
//                             auth: distill_token
//   portfolio.sharesies.nz  — per-holding cost basis/value, auth: rakaia_token
// A Sharesies account is NOT one portfolio — getProducts() lists all of
// them, and the caller (the Import dialog) picks which one to pull into a
// given app portfolio.

const LOGIN_URL = 'https://app.sharesies.nz/api/identity/login';

// Exchange -> Yahoo ticker suffix, so imported symbols price immediately via
// the existing Finnhub/Yahoo pipeline (see server/yahoo.js).
const EXCHANGE_SUFFIX = {
  NZX: '.NZ',
  ASX: '.AX',
  // US exchanges (NASDAQ/NYSE) need no suffix for Yahoo/Finnhub.
};

const fs = require('fs');
const path = require('path');
const SESSION_DIR = path.join(__dirname, '..', 'data', 'sharesies-sessions');
try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch {}
// uid is a Supabase auth uuid already (verified server-side — see the note
// above), safe as a filename as-is; sanitized anyway to be defensive.
const sessionFile = (uid) => path.join(SESSION_DIR, String(uid).replace(/[^A-Za-z0-9-]/g, '_') + '.json');

const sessions = new Map(); // uid -> { cookie, distillToken, rakaiaToken, portfolioId }
const pendings = new Map(); // uid -> { cookie, email, password } awaiting a 2FA code — never persisted

// Reload any sessions saved before the last restart.
try {
  for (const f of fs.readdirSync(SESSION_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const uid = f.slice(0, -'.json'.length);
      sessions.set(uid, JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8')));
    } catch {}
  }
} catch {}

function setSession(uid, session) {
  sessions.set(uid, session);
  try { fs.writeFileSync(sessionFile(uid), JSON.stringify(session)); } catch {}
}
function deleteSession(uid) {
  sessions.delete(uid);
  try { fs.unlinkSync(sessionFile(uid)); } catch {}
}

function requireUid(uid) {
  if (!uid) throw new Error('Missing user id — sign in again');
  return uid;
}

function cookieHeaderFrom(setCookieHeaders) {
  if (!setCookieHeaders) return '';
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  return list.map((c) => c.split(';')[0]).join('; ');
}

function sessionFrom(cookie, body) {
  return {
    cookie,
    distillToken: body.distill_token,
    rakaiaToken: body.rakaia_token,
    portfolioId: body.user?.portfolio_id,
  };
}

// Step 1: email + password. Sharesies replies one of:
//  - fully logged in (has distill_token) -> session ready
//  - a 2FA challenge ({ type: 'identity_mfa_required' }, no token yet, but a
//    session cookie identifying the partial login) -> caller must call
//    completeTwoFactor(uid, code)
async function login(uid, email, password) {
  requireUid(uid);
  const r = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, remember: true }),
  });
  const cookie = cookieHeaderFrom(r.headers.getSetCookie?.() || r.headers.get('set-cookie'));
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `Sharesies login failed (${r.status})`);

  if (body.distill_token) {
    setSession(uid, sessionFrom(cookie, body));
    pendings.delete(uid);
    return { status: 'connected' };
  }
  // A wrong email/password is NOT an HTTP error here — Sharesies answers 200
  // with { authenticated: false, type: 'identity_anonymous' }. Treating any
  // token-less reply as a 2FA challenge made a bad password surface later as
  // "Incorrect code", so only a real challenge is accepted as one.
  if (body.type !== 'identity_mfa_required') {
    throw new Error('Incorrect email or password');
  }
  pendings.set(uid, { cookie, email, password });
  return { status: 'mfa_required' };
}

// Step 2: the 6-digit code from the user's authenticator app. The same
// login endpoint accepts it back as `mfa_token` (confirmed against a real
// 2FA-enabled account — the login response's `invalid_mfa_token` flag was
// the tell for the field name).
async function completeTwoFactor(uid, code) {
  requireUid(uid);
  const pending = pendings.get(uid);
  if (!pending) throw new Error('No login in progress — enter email/password first');
  const r = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pending.cookie },
    body: JSON.stringify({ email: pending.email, password: pending.password, remember: true, mfa_token: code }),
  });
  const cookie = cookieHeaderFrom(r.headers.getSetCookie?.() || r.headers.get('set-cookie')) || pending.cookie;
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.distill_token) {
    if (body?.type === 'identity_anonymous') throw new Error('Incorrect email or password — go back and re-enter them');
    throw new Error(body?.error || 'Incorrect code');
  }
  setSession(uid, sessionFrom(cookie, body));
  pendings.delete(uid);
  return { status: 'connected' };
}

// Lists every product under the account — Invest, KiwiSaver, Save (can be
// several, e.g. named savings goals), Wallet (the main cash balance) — each
// with its own portfolio id. This is what powers the "which Sharesies
// account?" picker in the Import dialog. Assumes a single (non-multi-actor)
// profile, which covers the personal-account case this connector targets.
async function getProducts(uid) {
  requireUid(uid);
  const session = sessions.get(uid);
  if (!session) throw new Error('Not connected — log in first');
  const r = await fetch('https://app.sharesies.nz/api/profiles', {
    headers: { Cookie: session.cookie, Authorization: `Bearer ${session.distillToken}` },
  });
  if (r.status === 401 || r.status === 403) {
    deleteSession(uid);
    throw new Error('Session expired — reconnect');
  }
  if (!r.ok) throw new Error(`Sharesies profiles fetch failed (${r.status})`);
  const body = await r.json();
  const profile = (body.profiles || []).find((p) => p.is_personal) || body.profiles?.[0];
  return (profile?.portfolios || []).map((p) => ({
    id: p.id,
    name: p.name,
    product: p.product, // INVEST | KIWISAVER | SAVE | WALLET
    balance: Number(p.balance ?? p.cash_balance ?? p.estimated_balance) || 0,
  }));
}

function status(uid) {
  if (sessions.has(uid)) return { connected: true, pending: false };
  if (pendings.has(uid)) return { connected: false, pending: true };
  return { connected: false, pending: false };
}

// Resolves one holding's fund id to a tradeable ticker via data.sharesies.nz,
// mapped to a Yahoo-friendly symbol using EXCHANGE_SUFFIX.
async function resolveSymbol(session, fundId) {
  const r = await fetch(`https://data.sharesies.nz/api/v1/instruments/${fundId}`, {
    headers: { Authorization: `Bearer ${session.distillToken}` },
  });
  if (!r.ok) throw new Error(`Sharesies instrument lookup failed (${r.status})`);
  const c = await r.json();
  const suffix = EXCHANGE_SUFFIX[c.exchange] || '';
  return (c.symbol || fundId) + suffix;
}

// A short, filesystem/ticker-safe tag for a product's name, so importing
// several Save goals (e.g. "Holiday", "Emergency fund") into one app
// portfolio doesn't collide on the same synthetic ticker.
function tickerSlug(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12) || 'X';
}

// KiwiSaver, Save, and Wallet all report in NZD and aren't made of
// individually tradeable market instruments (KiwiSaver's underlying fund
// units are Sharesies-internal, not something Finnhub/Yahoo can ever price;
// Save/Wallet are plain cash). Rather than leave a position stuck at $0
// forever waiting for a price source that will never exist, these are
// represented as a single synthetic "1 share" position: shares=1,
// cost=total cost basis, price=total current value — so gain/loss still
// shows correctly, and nothing ever needs live re-pricing. The `.NZ` ticker
// suffix is what tells this app's currency conversion (see Currency.of in
// prices.js) that the number is NZD, not USD — without it, a real NZD
// balance would silently get treated as USD and converted wrong.
async function getCashLikeHolding(session, product) {
  const r = await fetch(`https://portfolio.sharesies.nz/api/v1/portfolios/${product.id}`, {
    headers: { Authorization: `Bearer ${session.rakaiaToken}` },
  }).catch(() => null);
  const body = r && r.ok ? await r.json().catch(() => null) : null;
  const value = body ? Number(body.portfolio_value) : product.balance;
  const costBasis = body ? Number(body.cost_basis) : product.balance;
  if (!(value > 0)) return [];
  const tag = product.product === 'KIWISAVER' ? 'KIWISAVER' : 'CASH-' + tickerSlug(product.name);
  return [{ ticker: tag + '.NZ', shares: 1, cost: costBasis || value, price: value }];
}

// Returns [{ ticker, shares, cost, price? }] — cost is per-share (cost_basis
// / shares_owned) for real stock holdings, matching this app's position
// shape (see openPosition in app.js). `price` is only set for the
// cash-like products above (see getCashLikeHolding); for real stocks it's
// left for Finnhub/Yahoo to fill in right after import, same as any
// manually-added position. Pulls live per-holding valuation from
// portfolio.sharesies.nz (the app.sharesies.nz portfolio list only has fund
// id + share count, no cost basis). `portfolioId` is one of the ids from
// getProducts() — the Invest one by default for backward compatibility, but
// callers should always pass the one the user actually picked in Import.
async function getHoldings(uid, portfolioId) {
  requireUid(uid);
  const session = sessions.get(uid);
  if (!session) throw new Error('Not connected — log in first');
  const pid = portfolioId || session.portfolioId;
  const products = await getProducts(uid);
  const product = products.find((p) => p.id === pid);
  if (product && product.product !== 'INVEST') return getCashLikeHolding(session, product);

  const r = await fetch(`https://portfolio.sharesies.nz/api/v1/portfolios/${pid}/instruments`, {
    headers: { Authorization: `Bearer ${session.rakaiaToken}` },
  });
  if (r.status === 401 || r.status === 403) {
    deleteSession(uid);
    throw new Error('Session expired — reconnect');
  }
  if (!r.ok) throw new Error(`Sharesies portfolio fetch failed (${r.status})`);
  const body = await r.json();
  const returns = body.instrument_returns || {};
  const holdable = Object.entries(returns).filter(([, v]) => Number(v.shares_owned) > 0);
  if (!holdable.length) return [];

  return Promise.all(
    holdable.map(async ([fundId, v]) => {
      const shares = Number(v.shares_owned) || 0;
      const costBasis = Number(v.cost_basis) || 0;
      return {
        ticker: await resolveSymbol(session, fundId),
        shares,
        cost: shares ? costBasis / shares : 0,
      };
    })
  );
}

// Returns [{ date, value, costBasis }] — Sharesies' own daily portfolio
// value/cost-basis timeseries (see the SHARESIES_API.md `portfolio_history`
// section). This is a one-off snapshot, not live: the caller persists it
// alongside the imported positions so the chart survives disconnecting.
// Not meaningful for WALLET/Save (a flat cash balance has no value history
// worth charting) — returns empty for those rather than calling an endpoint
// that doesn't apply to them.
async function getPortfolioHistory(uid, portfolioId) {
  requireUid(uid);
  const session = sessions.get(uid);
  if (!session) throw new Error('Not connected — log in first');
  const pid = portfolioId || session.portfolioId;
  const products = await getProducts(uid);
  const product = products.find((p) => p.id === pid);
  if (product && (product.product === 'WALLET' || product.product === 'SAVE')) return [];

  const r = await fetch(`https://portfolio.sharesies.nz/api/v1/portfolios/${pid}`, {
    headers: { Authorization: `Bearer ${session.rakaiaToken}` },
  });
  if (r.status === 401 || r.status === 403) {
    deleteSession(uid);
    throw new Error('Session expired — reconnect');
  }
  if (!r.ok) throw new Error(`Sharesies portfolio fetch failed (${r.status})`);
  const body = await r.json();
  return (body.portfolio_history || []).map((p) => ({
    date: p.date,
    value: Number(p.portfolio_value) || 0,
    costBasis: Number(p.cost_basis) || 0,
  }));
}

function logout(uid) {
  deleteSession(uid);
  pendings.delete(uid);
}

module.exports = { login, completeTwoFactor, status, getProducts, getHoldings, getPortfolioHistory, logout };
