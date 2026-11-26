// prefs-sync.js — keeps the app's display preferences on the user's account.
//
// Everything below is already stored in localStorage by the rest of the app
// (theme, tab/row colours, orders, linked portfolios, favourites...). Rather
// than rewrite each of those, this watches localStorage writes to a fixed list
// of keys and mirrors them to Supabase (user_settings.prefs), and on sign-in
// pulls the account's copy back down. localStorage stays the fast cache; the
// account copy is the one that survives clearing site data and follows the
// user to a new device. Must load before app.js. If the prefs column isn't
// there yet (migration not run) every call fails quietly and the app behaves
// exactly as before, per-device.
(() => {
  const KEYS = [
    'cashmoney.theme', 'cashmoney.customColors', 'cashmoney.accent',
    'cashmoney.favourites', 'cashmoney.allocFormat', 'cashmoney.allocData',
    'cashmoney.tabColors', 'cashmoney.rowColors', 'cashmoney.portfolioOrder',
    'cashmoney.holdingsOrder', 'cashmoney.coverageOrder', 'cashmoney.linkedPids',
    'cashmoney.displayCcy', 'cashmoney.displayCcyByPf', 'cashmoney.researchList',
    'cashmoney.customRevenue', 'cashmoney.gainMode',
  ];
  const watched = new Set(KEYS);
  let applying = false; // true while writing the account's values locally — those must not echo back up
  let signedIn = false;
  let timer = null;

  const snapshot = () => {
    const out = {};
    for (const k of KEYS) {
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    }
    return out;
  };
  // Keys removed locally since the last upload — they must also leave the
  // account's copy, or the next pull would bring them straight back.
  const removed = new Set();
  const push = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!signedIn) return;
      try {
        // Merge into the account's current copy rather than overwriting it, so
        // two devices changing different settings can't wipe each other's.
        const merged = { ...(await Store.getPrefs()), ...snapshot() };
        for (const k of removed) if (localStorage.getItem(k) === null) delete merged[k];
        removed.clear();
        await Store.savePrefs(merged);
      } catch (e) {
        console.warn('Preferences not saved to account:', e.message || e);
      }
    }, 1500);
  };

  const rawSet = Storage.prototype.setItem;
  const rawRemove = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) {
    rawSet.call(this, k, v);
    if (this === localStorage && !applying && watched.has(k)) push();
  };
  Storage.prototype.removeItem = function (k) {
    rawRemove.call(this, k);
    if (this === localStorage && !applying && watched.has(k)) { removed.add(k); push(); }
  };

  // Per-item maps (colours, currency choices). The first time a device ever
  // syncs, its own entries are combined with the account's rather than being
  // thrown away, so the laptop's colours and the phone's colours both survive.
  const MAP_KEYS = ['cashmoney.tabColors', 'cashmoney.rowColors', 'cashmoney.displayCcyByPf', 'cashmoney.customRevenue'];
  const MERGED_FLAG = 'cashmoney.prefsMerged'; // not synced: marks "this device has joined the account's copy"

  // Pull the account's copy. The account's values win; anything only this
  // browser has is kept and uploaded. If that changed something the page
  // already read at load (theme, colours...), reload so the whole UI uses it —
  // at most once a minute, so two devices can never ping-pong.
  async function pull() {
    let remote;
    try { remote = await Store.getPrefs(); } catch (e) { console.warn('Preferences not loaded from account:', e.message || e); return; }
    signedIn = true;
    let changed = false;
    let needsUpload = false;
    applying = true;
    try {
      const firstTime = localStorage.getItem(MERGED_FLAG) === null;
      for (const k of KEYS) {
        let want = remote[k];
        if (firstTime && MAP_KEYS.includes(k) && typeof want === 'string' && localStorage.getItem(k) !== null) {
          try {
            const union = { ...JSON.parse(localStorage.getItem(k)), ...JSON.parse(want) };
            const text = JSON.stringify(union);
            if (text !== want) needsUpload = true;
            want = text;
          } catch {}
        }
        if (typeof want === 'string' && localStorage.getItem(k) !== want) {
          rawSet.call(localStorage, k, want);
          changed = true;
        }
      }
      rawSet.call(localStorage, MERGED_FLAG, '1');
    } finally { applying = false; }
    if (needsUpload || KEYS.some((k) => remote[k] === undefined && localStorage.getItem(k) !== null)) push();
    let last = 0;
    try { last = Number(sessionStorage.getItem('cashmoney.prefsReloadedAt')) || 0; } catch {}
    if (changed && Date.now() - last > 60000) {
      try { sessionStorage.setItem('cashmoney.prefsReloadedAt', String(Date.now())); } catch {}
      location.reload();
    }
  }

  // Called from index.html once window.sb (the Supabase client) exists — this
  // file loads before that, so it can't subscribe to auth at load time.
  let started = false;
  window.PrefsSync = {
    start() {
      let lastPull = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !signedIn || Date.now() - lastPull < 30000) return;
        lastPull = Date.now();
        pull();
      });
      Store.onAuth((session) => {
        if (session && session.user) {
          if (!started) { started = true; pull(); }
        } else {
          signedIn = false;
          started = false;
        }
      });
    },
  };
})();
