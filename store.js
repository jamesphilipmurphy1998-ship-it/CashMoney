// store.js — auth + data via Supabase, straight from the browser.
//
// The browser uses the public key (window.sb is created in index.html). Every
// query runs as the logged-in user; row-level security (supabase/schema.sql)
// guarantees you only ever read or write your own rows.

const Store = (() => {
  const sb = () => window.sb;

  function id() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ── auth ──────────────────────────────────────────────────────────────
  function onAuth(cb) {
    sb().auth.onAuthStateChange((_event, session) => cb(session));
  }
  function signInWithGoogle() {
    return sb().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
        queryParams: { prompt: 'select_account' },
      },
    });
  }
  function signOut() {
    return sb().auth.signOut();
  }
  // Uploads a profile photo to the public "avatars" bucket at
  // <uid>/avatar.<ext> (storage RLS restricts writes to that uid's own
  // folder — see supabase/schema.sql), then points the auth user's
  // avatar_url metadata at it so it shows up everywhere (Profile page,
  // future avatar chips) without another upload. Returns the public URL.
  async function uploadAvatar(uid, file) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${uid}/avatar.${ext}`;
    const up = await sb().storage.from('avatars').upload(path, file, { upsert: true, cacheControl: '3600' });
    if (up.error) throw up.error;
    const { data } = sb().storage.from('avatars').getPublicUrl(path);
    // Cache-bust so the new photo shows immediately (same path, new content).
    const url = data.publicUrl + '?t=' + Date.now();
    const upd = await sb().auth.updateUser({ data: { avatar_url: url } });
    if (upd.error) throw upd.error;
    return url;
  }

  // ── portfolios ────────────────────────────────────────────────────────
  async function listPortfolios() {
    const r = await sb().from('portfolios').select('*').order('created_at', { ascending: true });
    if (r.error) throw r.error;
    return r.data || [];
  }
  async function createPortfolio(name, pid) {
    const row = { id: pid || id(), name };
    const r = await sb().from('portfolios').insert(row);
    if (r.error) throw r.error;
    return row;
  }
  async function renamePortfolio(pid, name) {
    const r = await sb().from('portfolios').update({ name }).eq('id', pid);
    if (r.error) throw r.error;
  }
  // Snapshot of Sharesies' own portfolio value history — see sharesies.js.
  // Saved once at import time so it survives disconnecting.
  async function saveSharesiesHistory(pid, history) {
    const r = await sb().from('portfolios').update({ sharesies_history: history, sharesies_synced_at: new Date().toISOString() }).eq('id', pid);
    if (r.error) throw r.error;
  }

  // Daily total-value history for the aggregated "Portfolio's summary" view
  // (see supabase/summary-history-migration.sql). One row per user per day —
  // recordSnapshot upserts today's, so it can be called freely without
  // creating duplicates or piling up intraday noise.
  async function loadSummaryHistory() {
    const r = await sb().from('summary_history').select('*').order('date', { ascending: true });
    if (r.error) throw r.error;
    return r.data || [];
  }
  async function recordSummarySnapshot(date, value) {
    const r = await sb().from('summary_history').upsert({ date, value });
    if (r.error) throw r.error;
  }
  // Marks a portfolio as Sharesies-linked the moment Import succeeds — kept
  // separate from saveSharesiesHistory because the history call can fail
  // independently of the holdings import (see refreshSharesiesLink in app.js).
  // portfolioId is which Sharesies product (Invest/KiwiSaver/Save/Wallet)
  // was chosen, so Refresh keeps pulling that same one.
  async function markSharesiesLinked(pid, portfolioId) {
    const r = await sb().from('portfolios').update({ sharesies_linked: true, sharesies_portfolio_id: portfolioId }).eq('id', pid);
    if (r.error) throw r.error;
  }
  // A user's own free Finnhub API key (see supabase/finnhub-key-migration.sql
  // and server/quotes.js's per-user loops) — optional, null means "use the
  // app's shared server key" (today's default). .maybeSingle() because a
  // brand-new user has no row here yet, which isn't an error.
  async function getFinnhubKey() {
    const r = await sb().from('user_settings').select('finnhub_key').maybeSingle();
    if (r.error) throw r.error;
    return r.data?.finnhub_key || '';
  }
  async function saveFinnhubKey(key) {
    const r = await sb().from('user_settings').upsert({ finnhub_key: key || null });
    if (r.error) throw r.error;
  }

  // Locked Bull case calculator projections (see supabase/bull-locks-migration.sql)
  // — one JSON blob per user, keyed by "TICKER::case" (bull/standard/bear each
  // lock independently), so a locked projection survives refreshes/logouts/
  // logins instead of only living in the page's in-memory state.
  // .maybeSingle() because a brand-new user has no row here yet.
  async function getBullLocks() {
    const r = await sb().from('user_settings').select('bull_locks').maybeSingle();
    if (r.error) throw r.error;
    return r.data?.bull_locks || {};
  }
  async function saveBullLock(key, snapshot) {
    const locks = await getBullLocks();
    locks[key] = snapshot;
    const r = await sb().from('user_settings').upsert({ bull_locks: locks });
    if (r.error) throw r.error;
  }
  async function deleteBullLock(key) {
    const locks = await getBullLocks();
    delete locks[key];
    const r = await sb().from('user_settings').upsert({ bull_locks: locks });
    if (r.error) throw r.error;
  }

  // Display preferences synced across devices (see prefs-sync.js and
  // supabase/prefs-migration.sql). One jsonb blob; {} for a new user.
  async function getPrefs() {
    const r = await sb().from('user_settings').select('prefs').maybeSingle();
    if (r.error) throw r.error;
    return r.data?.prefs || {};
  }
  async function savePrefs(prefs) {
    const r = await sb().from('user_settings').upsert({ prefs });
    if (r.error) throw r.error;
  }

  // Delete a portfolio and everything in it. No FK cascade on portfolio_id,
  // so clear the holdings and notes first, then the portfolio row.
  async function deletePortfolio(pid) {
    const pos = await sb().from('positions').delete().eq('portfolio_id', pid);
    if (pos.error) throw pos.error;
    const notes = await sb().from('notes').delete().eq('portfolio_id', pid);
    if (notes.error) throw notes.error;
    const r = await sb().from('portfolios').delete().eq('id', pid);
    if (r.error) throw r.error;
  }
  // Assign any pre-portfolio rows (portfolio_id null) to a portfolio.
  // Returns how many rows were adopted, so first-run can decide whether to seed.
  async function adoptOrphans(pid) {
    const [p, n] = await Promise.all([
      sb().from('positions').update({ portfolio_id: pid }).is('portfolio_id', null).select('id'),
      sb().from('notes').update({ portfolio_id: pid }).is('portfolio_id', null).select('id'),
    ]);
    if (p.error) throw p.error;
    if (n.error) throw n.error;
    return (p.data || []).length + (n.data || []).length;
  }

  // ── data (scoped to a portfolio) ──────────────────────────────────────
  // Only the columns the app owns — never send user_id/updated_at; the
  // database fills user_id (default auth.uid()) and timestamps itself.
  const POS_COLS = ['id', 'ticker', 'shares', 'cost', 'price', 'day', 'category'];
  const NOTE_COLS = ['id', 'title', 'body'];
  const pick = (obj, cols) => Object.fromEntries(cols.map((k) => [k, obj[k]]));

  async function load(pid) {
    const [pos, notes] = await Promise.all([
      sb().from('positions').select('*').eq('portfolio_id', pid),
      sb().from('notes').select('*').eq('portfolio_id', pid),
    ]);
    if (pos.error) throw pos.error;
    if (notes.error) throw notes.error;
    return { positions: pos.data || [], notes: notes.data || [] };
  }

  // Everything the user owns, across all portfolios — for the aggregated
  // summary view. RLS scopes this to the current user; it's read-only, so
  // there's no matching save.
  async function loadAll() {
    const [pos, notes] = await Promise.all([
      sb().from('positions').select('*'),
      sb().from('notes').select('*'),
    ]);
    if (pos.error) throw pos.error;
    if (notes.error) throw notes.error;
    return { positions: pos.data || [], notes: notes.data || [] };
  }

  async function save(pid, state) {
    await Promise.all([
      replace('positions', pid, (state.positions || []).map((r) => ({ ...pick(r, POS_COLS), portfolio_id: pid }))),
      replace('notes', pid, (state.notes || []).map((r) => ({ ...pick(r, NOTE_COLS), portfolio_id: pid }))),
    ]);
  }

  // Whole-collection replace, scoped to ONE portfolio: upsert what's present,
  // delete what's gone — but only within this portfolio, never other ones.
  async function replace(table, pid, rows) {
    if (rows.length) {
      const up = await sb().from(table).upsert(rows);
      if (up.error) throw up.error;
      const ids = rows.map((r) => r.id).join(',');
      const del = await sb().from(table).delete().eq('portfolio_id', pid).not('id', 'in', `(${ids})`);
      if (del.error) throw del.error;
    } else {
      const del = await sb().from(table).delete().eq('portfolio_id', pid);
      if (del.error) throw del.error;
    }
  }

  function seed() {
    return {
      positions: [
        { id: id(), ticker: 'VOO', shares: 180, cost: 410, price: 548.3, day: 0.4, category: 'ETFs' },
        { id: id(), ticker: 'AAPL', shares: 60, cost: 165, price: 214.1, day: 0.6, category: 'Tech' },
        { id: id(), ticker: 'NVDA', shares: 48, cost: 95, price: 172.4, day: 2.8, category: 'Tech' },
        { id: id(), ticker: 'TSLA', shares: 30, cost: 270, price: 248.9, day: -1.9, category: 'Auto' },
      ],
      notes: [
        { id: id(), title: 'NVDA · earnings thesis', body: 'Data-center demand still accelerating. Watching gross margin and any guide on supply constraints.' },
        { id: id(), title: 'TSLA · trim on strength?', body: 'Margins compressing. Consider trimming into rallies above cost basis.' },
      ],
    };
  }

  return { load, loadAll, save, id, onAuth, signInWithGoogle, signOut, uploadAvatar, listPortfolios, createPortfolio, renamePortfolio, deletePortfolio, adoptOrphans, saveSharesiesHistory, markSharesiesLinked, loadSummaryHistory, recordSummarySnapshot, getFinnhubKey, saveFinnhubKey, getBullLocks, saveBullLock, getPrefs, savePrefs, deleteBullLock, seed };
})();
