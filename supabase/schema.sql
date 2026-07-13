-- Portfolio tracker schema — multi-user with login.
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- Each row belongs to a user (user_id = the logged-in account). Row-level
-- security makes the database itself enforce that a user can only ever read
-- or write their own rows — even though the browser uses the public key.

-- ── portfolios ──────────────────────────────────────────────────────────
-- A user can have many named portfolios; holdings and notes belong to one.
create table if not exists portfolios (
  id                 text primary key,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name               text not null,
  created_at         timestamptz not null default now(),
  -- Snapshot of Sharesies' own portfolio value history, taken at import time
  -- (see server/sharesies.js). Persists after disconnecting — only refreshed
  -- on the next "Import portfolio" click, never live.
  sharesies_history   jsonb,
  sharesies_synced_at timestamptz,
  -- True the moment Import portfolio succeeds, independent of whether the
  -- history snapshot also succeeded — Refresh checks this to decide whether
  -- to re-sync from Sharesies (see refreshSharesiesLink in app.js).
  sharesies_linked    boolean not null default false,
  -- Which Sharesies product (Invest/KiwiSaver/Save/Wallet — see getProducts
  -- in server/sharesies.js) this app portfolio was imported from, so Refresh
  -- keeps pulling the right one instead of defaulting back to Invest.
  sharesies_portfolio_id text
);

-- ── positions ───────────────────────────────────────────────────────────
create table if not exists positions (
  id           text primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  portfolio_id text,
  ticker       text not null,
  shares       numeric not null default 0,
  cost         numeric not null default 0,
  price        numeric not null default 0,
  day          numeric not null default 0,
  category     text default '',
  updated_at   timestamptz not null default now()
);

-- ── notes ───────────────────────────────────────────────────────────────
create table if not exists notes (
  id           text primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  portfolio_id text,
  title        text not null,
  body         text default '',
  updated_at   timestamptz not null default now()
);

-- ── summary_history ─────────────────────────────────────────────────────
-- One row per user per day: the aggregated "Portfolio's summary" total value
-- (converted to USD so it stays comparable regardless of later display-
-- currency changes — see totalValueUSD in app.js), recorded once per day so
-- the summary's growth chart has real history. There's no way to derive past
-- totals, so this starts the day it's first written ("day 0").
create table if not exists summary_history (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date       date not null,
  value      numeric not null,
  primary key (user_id, date)
);

-- ── user_settings ───────────────────────────────────────────────────────
-- One row per user. finnhub_key: a user's own free Finnhub API key (Connectors
-- page), so their portfolio holdings refresh on their own 60-calls/min budget
-- instead of sharing the app's single server-wide key with every other user
-- (see server/quotes.js's per-user loops). Optional — null means "use the
-- shared server key", today's default behaviour.
create table if not exists user_settings (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  finnhub_key text
);

-- ── row-level security ──────────────────────────────────────────────────
alter table portfolios       enable row level security;
alter table positions        enable row level security;
alter table notes            enable row level security;
alter table summary_history  enable row level security;
alter table user_settings    enable row level security;

-- One policy per table: you may do anything to rows that are yours, and the
-- database forces new rows to be stamped with your id.
create policy "own portfolios" on portfolios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own positions" on positions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own notes" on notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own summary history" on summary_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own settings" on user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
