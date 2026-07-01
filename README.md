# Portfolio tracker

A simple stock-portfolio dashboard: holdings with computed P/L, allocation,
and research notes. Plain HTML/CSS/JS frontend, zero-dependency Node backend.

## Run it

```bash
./start.sh
```

Then open http://localhost:4178. The script uses Cursor's bundled Node, so
no separate Node install is required. (Override with `NODE_BIN=/path/to/node`.)

## Auth + data (Supabase)

Login is **Google sign-in via Supabase Auth**, run entirely in the browser.
The page loads the Supabase client from a CDN (no `npm`), signs the user in,
and queries the database directly using the **publishable** key in
[`config.js`](config.js). Row-level security (see below) makes the database
enforce that each account only sees its own rows — that's the real security
boundary, not the key.

`server/` (the zero-dep Node server) now just serves the static files; the old
JSON `/api` data store is unused once Supabase is connected.

### One-time setup (things only you can do)

1. **Create the tables.** Supabase dashboard → SQL → New query → paste and run
   [`supabase/schema.sql`](supabase/schema.sql). This creates `positions` and
   `notes` with `user_id` columns and RLS policies.
2. **Enable Google sign-in.**
   - In Google Cloud Console: create an OAuth 2.0 Client (Web application).
   - Authorized redirect URI: the value Supabase shows you, which is
     `https://xpnlwubonzozfawztsry.supabase.co/auth/v1/callback`.
   - Copy the Client ID + secret into Supabase dashboard → Authentication →
     Providers → Google → enable + paste.
3. **Allow the app's URL.** Supabase dashboard → Authentication → URL
   Configuration → add `http://localhost:4178` to Site URL and Redirect URLs
   (add your real domain later when you deploy).

The values in `config.js` (project URL + publishable key) are already filled in
and are safe to commit — they're meant to be public.

## Live prices (later)

Prices are entered by hand for now. To go live, implement `fetchQuotes()` in
[`prices.js`](prices.js) and set `live: true` — the Refresh button and UI are
already wired to it. A worked Finnhub example is in the comments there.

## Layout

```
index.html, styles.css, app.js   frontend UI + P/L math
prices.js                        the live-data seam
store.js                         frontend API client (+ localStorage cache)
server/server.js                 zero-dep HTTP server + JSON API
server/db.js                     storage: JSON file now, Supabase when configured
supabase/schema.sql              run once to create the tables
data/db.json                     local store (gitignored)
```
