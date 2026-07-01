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

  // ── data ──────────────────────────────────────────────────────────────
  // Only the columns the app owns — never send user_id/updated_at; the
  // database fills user_id (default auth.uid()) and timestamps itself.
  const POS_COLS = ['id', 'ticker', 'shares', 'cost', 'price', 'day', 'category'];
  const NOTE_COLS = ['id', 'title', 'body'];
  const pick = (obj, cols) => Object.fromEntries(cols.map((k) => [k, obj[k]]));

  async function load() {
    const [pos, notes] = await Promise.all([
      sb().from('positions').select('*'),
      sb().from('notes').select('*'),
    ]);
    if (pos.error) throw pos.error;
    if (notes.error) throw notes.error;

    let positions = pos.data || [];
    let noteRows = notes.data || [];

    // Brand-new account: drop in sample data so the dashboard isn't empty.
    if (!positions.length && !noteRows.length) {
      const seeded = seed();
      await save(seeded);
      return seeded;
    }
    return { positions, notes: noteRows };
  }

  async function save(state) {
    await Promise.all([
      replace('positions', (state.positions || []).map((r) => pick(r, POS_COLS))),
      replace('notes', (state.notes || []).map((r) => pick(r, NOTE_COLS))),
    ]);
  }

  // Whole-collection replace, scoped to the current user by RLS: upsert
  // what's present, delete what's gone.
  async function replace(table, rows) {
    if (rows.length) {
      const up = await sb().from(table).upsert(rows);
      if (up.error) throw up.error;
      const ids = rows.map((r) => r.id).join(',');
      const del = await sb().from(table).delete().not('id', 'in', `(${ids})`);
      if (del.error) throw del.error;
    } else {
      // Delete all of *your* rows (RLS keeps this scoped to you).
      const del = await sb().from(table).delete().neq('id', '');
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

  return { load, save, id, onAuth, signInWithGoogle, signOut };
})();
