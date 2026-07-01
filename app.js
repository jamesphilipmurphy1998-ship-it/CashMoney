// app.js — UI wiring and rendering.

const PALETTE = ['#378add', '#1d9e75', '#7f77dd', '#d85a30', '#ef9f27', '#d4537e', '#639922'];

let state = { positions: [], notes: [] };

const $ = (sel) => document.querySelector(sel);

const money = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const money2 = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const pct = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;
const signClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

// ---- Calculations -------------------------------------------------------

function positionValue(p) {
  return Prices.getPrice(p) * Number(p.shares);
}
function positionCost(p) {
  return Number(p.cost) * Number(p.shares);
}
function positionDayChange(p) {
  // Day $ move = today's value minus value at yesterday's close.
  const v = positionValue(p);
  const dp = Prices.getDayChange(p) / 100;
  const prev = v / (1 + dp);
  return v - prev;
}

function totals() {
  const value = state.positions.reduce((s, p) => s + positionValue(p), 0);
  const cost = state.positions.reduce((s, p) => s + positionCost(p), 0);
  const dayMove = state.positions.reduce((s, p) => s + positionDayChange(p), 0);
  const totalGain = value - cost;
  const prevValue = value - dayMove;
  return {
    value,
    cost,
    dayMove,
    dayPct: prevValue ? (dayMove / prevValue) * 100 : 0,
    totalGain,
    totalPct: cost ? (totalGain / cost) * 100 : 0,
  };
}

// ---- Rendering ----------------------------------------------------------

let ready = false; // becomes true once data is loaded, so renders don't save back during boot

function render() {
  renderMetrics();
  renderHoldings();
  renderAllocation();
  renderNotes();
  $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  if (ready) Store.save(state).catch((e) => console.warn('Save failed:', e));
}

function renderMetrics() {
  const t = totals();
  const cards = [
    { label: 'Total value', value: money(t.value), cls: '' },
    {
      label: 'Today',
      value: `${t.dayMove >= 0 ? '+' : '−'}${money(Math.abs(t.dayMove)).replace('$', '$')} <span class="sub">${pct(t.dayPct)}</span>`,
      cls: signClass(t.dayMove),
    },
    {
      label: 'Total gain',
      value: `${t.totalGain >= 0 ? '+' : '−'}${money(Math.abs(t.totalGain))} <span class="sub">${pct(t.totalPct)}</span>`,
      cls: signClass(t.totalGain),
    },
  ];
  $('#metrics').innerHTML = cards
    .map(
      (c) => `<div class="metric">
        <p class="label">${c.label}</p>
        <p class="value ${c.cls}">${c.value}</p>
      </div>`
    )
    .join('');
}

function renderHoldings() {
  const body = $('#holdings-body');
  const empty = $('#holdings-empty');
  $('#holdings-count').textContent = state.positions.length
    ? `${state.positions.length} position${state.positions.length > 1 ? 's' : ''}`
    : '';

  if (!state.positions.length) {
    body.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  body.innerHTML = state.positions
    .map((p) => {
      const value = positionValue(p);
      const gain = value - positionCost(p);
      const gainPct = positionCost(p) ? (gain / positionCost(p)) * 100 : 0;
      const day = Prices.getDayChange(p);
      return `<tr data-id="${p.id}">
        <td><span class="ticker">${esc(p.ticker)}</span></td>
        <td class="num">${fmtShares(p.shares)}</td>
        <td class="num">${money2(p.cost)}</td>
        <td class="num">${money2(Prices.getPrice(p))}</td>
        <td class="num ${signClass(day)}">${pct(day)}</td>
        <td class="num">${money(value)}</td>
        <td class="num ${signClass(gain)}">${gain >= 0 ? '+' : '−'}${money(Math.abs(gain))} <span class="muted">${pct(gainPct)}</span></td>
        <td class="row-actions"><button class="icon-btn" data-del="${p.id}" title="Remove" aria-label="Remove ${esc(p.ticker)}">×</button></td>
      </tr>`;
    })
    .join('');
}

function renderAllocation() {
  const bar = $('#alloc-bar');
  const legend = $('#alloc-legend');
  const t = totals();
  if (!t.value) {
    bar.innerHTML = '';
    legend.innerHTML = '<span class="alloc-empty">Add positions to see allocation.</span>';
    return;
  }
  const groups = {};
  for (const p of state.positions) {
    const key = (p.category || 'Uncategorized').trim() || 'Uncategorized';
    groups[key] = (groups[key] || 0) + positionValue(p);
  }
  const rows = Object.entries(groups)
    .sort((a, b) => b[1] - a[1])
    .map(([name, val], i) => ({ name, val, share: (val / t.value) * 100, color: PALETTE[i % PALETTE.length] }));

  bar.innerHTML = rows.map((r) => `<span style="width:${r.share}%;background:${r.color}"></span>`).join('');
  legend.innerHTML = rows
    .map(
      (r) => `<div class="row">
        <span class="name"><span class="swatch" style="background:${r.color}"></span>${esc(r.name)}</span>
        <span>${r.share.toFixed(0)}%</span>
      </div>`
    )
    .join('');
}

function renderNotes() {
  const wrap = $('#notes');
  if (!state.notes.length) {
    wrap.innerHTML = '<span class="notes-empty">No research notes yet.</span>';
    return;
  }
  wrap.innerHTML = state.notes
    .map(
      (n) => `<div class="note" data-note="${n.id}">
        <p class="n-title">${esc(n.title)}</p>
        <p class="n-body">${esc(n.body || '')}</p>
      </div>`
    )
    .join('');
}

// ---- Helpers ------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtShares(n) {
  const num = Number(n);
  return Number.isInteger(num) ? num.toString() : num.toFixed(2);
}

// ---- Position dialog ----------------------------------------------------

const posDialog = $('#position-dialog');
let editingId = null;

function openPosition(p) {
  editingId = p ? p.id : null;
  $('#position-title').textContent = p ? 'Edit position' : 'Add position';
  $('#f-ticker').value = p ? p.ticker : '';
  $('#f-shares').value = p ? p.shares : '';
  $('#f-cost').value = p ? p.cost : '';
  $('#f-price').value = p ? p.price : '';
  $('#f-day').value = p ? p.day : '';
  $('#f-category').value = p ? p.category || '' : '';
  posDialog.showModal();
  $('#f-ticker').focus();
}

$('#add-btn').addEventListener('click', () => openPosition(null));
$('#position-cancel').addEventListener('click', () => posDialog.close());

$('#position-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = {
    ticker: $('#f-ticker').value.trim().toUpperCase(),
    shares: parseFloat($('#f-shares').value) || 0,
    cost: parseFloat($('#f-cost').value) || 0,
    price: parseFloat($('#f-price').value) || 0,
    day: parseFloat($('#f-day').value) || 0,
    category: $('#f-category').value.trim(),
  };
  if (!data.ticker) return;
  if (editingId) {
    const p = state.positions.find((x) => x.id === editingId);
    if (p) Object.assign(p, data);
  } else {
    state.positions.push({ id: Store.id(), ...data });
  }
  posDialog.close();
  render();
});

// Row clicks: edit on row, delete on the × button.
$('#holdings-body').addEventListener('click', (e) => {
  const delId = e.target.getAttribute('data-del');
  if (delId) {
    state.positions = state.positions.filter((p) => p.id !== delId);
    render();
    return;
  }
  const row = e.target.closest('tr[data-id]');
  if (row) {
    const p = state.positions.find((x) => x.id === row.dataset.id);
    if (p) openPosition(p);
  }
});

// ---- Note dialog --------------------------------------------------------

const noteDialog = $('#note-dialog');
let editingNote = null;

function openNote(n) {
  editingNote = n ? n.id : null;
  $('#note-title').textContent = n ? 'Edit note' : 'New note';
  $('#n-title').value = n ? n.title : '';
  $('#n-body').value = n ? n.body || '' : '';
  $('#note-delete').hidden = !n;
  noteDialog.showModal();
  $('#n-title').focus();
}

$('#add-note-btn').addEventListener('click', () => openNote(null));
$('#note-cancel').addEventListener('click', () => noteDialog.close());

$('#note-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = { title: $('#n-title').value.trim(), body: $('#n-body').value.trim() };
  if (!data.title) return;
  if (editingNote) {
    const n = state.notes.find((x) => x.id === editingNote);
    if (n) Object.assign(n, data);
  } else {
    state.notes.unshift({ id: Store.id(), ...data });
  }
  noteDialog.close();
  render();
});

$('#note-delete').addEventListener('click', () => {
  state.notes = state.notes.filter((n) => n.id !== editingNote);
  noteDialog.close();
  render();
});

$('#notes').addEventListener('click', (e) => {
  const card = e.target.closest('.note[data-note]');
  if (card) {
    const n = state.notes.find((x) => x.id === card.dataset.note);
    if (n) openNote(n);
  }
});

// ---- Refresh (live-data hook) -------------------------------------------

$('#refresh-btn').addEventListener('click', async () => {
  const pill = $('#status-pill');
  if (!Prices.live) {
    render(); // manual mode: just recompute + timestamp
    return;
  }
  try {
    const quotes = await Prices.fetchQuotes(state.positions.map((p) => p.ticker));
    for (const p of state.positions) {
      const q = quotes[p.ticker];
      if (q) {
        p.price = q.price;
        p.day = q.day;
      }
    }
    pill.classList.add('live');
    pill.innerHTML = '<span class="dot"></span>Live';
    render();
  } catch (err) {
    console.warn(err);
  }
});

// ---- Auth + boot --------------------------------------------------------

function showLogin() {
  ready = false;
  currentUid = null;
  $('#login-screen').hidden = false;
  $('#app').hidden = true;
}

let currentUid = null;

async function showApp(user) {
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  const email = user.email || '';
  $('#user-email').textContent = email;
  $('#user-chip').hidden = !email;

  // Auth can fire more than once per sign-in (initial-session + signed-in);
  // only load once per user so concurrent seed passes don't race.
  if (currentUid === user.id) return;
  currentUid = user.id;

  ready = false;
  try {
    state = await Store.load();
    ready = true;
    render();
  } catch (e) {
    console.error('Load failed:', e);
    $('#updated').textContent = 'Could not load data — check the table setup.';
  }
}

$('#google-btn').addEventListener('click', async () => {
  const err = $('#login-err');
  err.hidden = true;
  const { error } = await Store.signInWithGoogle();
  if (error) {
    err.textContent = error.message;
    err.hidden = false;
  }
});

$('#signout-btn').addEventListener('click', () => Store.signOut());

const App = {
  // Called from the S&P 500 board's "Add to holdings" button.
  addFromMarket(symbol, price) {
    openPosition(null);
    $('#f-ticker').value = symbol;
    if (price) $('#f-price').value = Number(price).toFixed(2);
  },
  boot() {
    // Fires immediately with the current session, and again on sign in/out.
    Store.onAuth((session) => {
      if (session && session.user) showApp(session.user);
      else showLogin();
    });
  },
};
window.App = App;
