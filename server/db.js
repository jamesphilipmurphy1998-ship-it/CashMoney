// db.js — storage abstraction with two backends.
//
//   • JSON file (default)  — zero setup, data in data/db.json
//   • Supabase (REST)      — used automatically when SUPABASE_URL +
//                            SUPABASE_KEY are set in the environment.
//
// Both expose the same two calls:
//   getState()        -> { positions: [...], notes: [...] }
//   saveState(state)  -> persists the whole document
//
// Switching to Supabase requires no code change here — just set the env
// vars (see server/.env.example) and run supabase/schema.sql once.

const fs = require('fs');
const path = require('path');

const TABLES = ['positions', 'notes'];

// ---- JSON file backend --------------------------------------------------

function fileBackend() {
  const dir = path.join(__dirname, '..', 'data');
  const file = path.join(dir, 'db.json');

  function read() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { positions: [], notes: [] };
    }
  }

  return {
    kind: 'json-file',
    async getState() {
      return read();
    },
    async saveState(state) {
      fs.mkdirSync(dir, { recursive: true });
      const clean = { positions: state.positions || [], notes: state.notes || [] };
      fs.writeFileSync(file, JSON.stringify(clean, null, 2));
      return clean;
    },
  };
}

// ---- Supabase REST backend ----------------------------------------------
// Uses the auto-generated PostgREST API at <url>/rest/v1/<table>. No client
// library needed — just fetch. Run supabase/schema.sql to create the tables.

function supabaseBackend(url, key) {
  const base = url.replace(/\/$/, '') + '/rest/v1';
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };

  async function req(method, pathAndQuery, body, extraHeaders) {
    const r = await fetch(base + pathAndQuery, {
      method,
      headers: { ...headers, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Supabase ${method} ${pathAndQuery} -> ${r.status} ${text}`);
    }
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }

  return {
    kind: 'supabase',
    async getState() {
      const state = {};
      for (const table of TABLES) {
        state[table] = await req('GET', `/${table}?select=*`);
      }
      return state;
    },
    async saveState(state) {
      // Whole-document replace: upsert everything present, then delete rows
      // that are no longer in the document. Fine for a single-user tracker.
      for (const table of TABLES) {
        const rows = state[table] || [];
        if (rows.length) {
          await req('POST', `/${table}`, rows, { Prefer: 'resolution=merge-duplicates' });
          const ids = rows.map((r) => `"${r.id}"`).join(',');
          await req('DELETE', `/${table}?id=not.in.(${ids})`);
        } else {
          await req('DELETE', `/${table}?id=not.is.null`);
        }
      }
      return state;
    },
  };
}

// ---- Pick a backend -----------------------------------------------------

function makeDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (url && key) {
    console.log('[db] using Supabase backend');
    return supabaseBackend(url, key);
  }
  console.log('[db] using local JSON file backend (data/db.json)');
  return fileBackend();
}

module.exports = makeDb();
