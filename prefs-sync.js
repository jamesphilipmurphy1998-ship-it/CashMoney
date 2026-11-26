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
    'cashmoney.customRevenue',
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
  const push = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!signedIn) return;
      Store.savePrefs(snapshot()).catch((e) => console.warn('Preferences not saved to account:', e.message || e));
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
    if (this === localStorage && !applying && watched.has(k)) push();
  };

  // On sign-in: the account's values win; anything only this browser has is
  // kept and uploaded. If adopting the account's values changed something the
  // page already read at load (theme, chart format...), reload once so the
  // whole UI starts from them.
  async function pull() {
    let remote;
    try { remote = await Store.getPrefs(); } catch (e) { console.warn('Preferences not loaded from account:', e.message || e); return; }
    signedIn = true;
    let changed = false;
    applying = true;
    try {
      for (const k of KEYS) {
        if (typeof remote[k] === 'string' && localStorage.getItem(k) !== remote[k]) {
          rawSet.call(localStorage, k, remote[k]);
          changed = true;
        }
      }
    } finally { applying = false; }
    const localOnly = KEYS.some((k) => remote[k] === undefined && localStorage.getItem(k) !== null);
    if (localOnly) push();
    let reloaded = false;
    try { reloaded = sessionStorage.getItem('cashmoney.prefsReloaded') === '1'; } catch {}
    if (changed && !reloaded) {
      try { sessionStorage.setItem('cashmoney.prefsReloaded', '1'); } catch {}
      location.reload();
    }
  }

  let started = false;
  Store.onAuth((session) => {
    if (session && session.user) {
      if (!started) { started = true; pull(); }
    } else {
      signedIn = false;
      started = false;
      try { sessionStorage.removeItem('cashmoney.prefsReloaded'); } catch {}
    }
  });
})();
