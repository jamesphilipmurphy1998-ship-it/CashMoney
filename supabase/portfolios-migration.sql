-- Migration: add multiple named portfolios per user.
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query).
-- Safe to run on an existing database — your current holdings/notes are kept
-- and get adopted into a default "My portfolio" by the app on next load.

-- A user can have many named portfolios.
create table if not exists portfolios (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

alter table portfolios enable row level security;
drop policy if exists "own portfolios" on portfolios;
create policy "own portfolios" on portfolios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Each holding and note now belongs to a portfolio.
alter table positions add column if not exists portfolio_id text;
alter table notes     add column if not exists portfolio_id text;

create index if not exists positions_portfolio_idx on positions (portfolio_id);
create index if not exists notes_portfolio_idx on notes (portfolio_id);

-- Sharesies portfolio-value history, snapshotted at import time (see
-- server/sharesies.js). Persists after disconnecting Sharesies.
alter table portfolios add column if not exists sharesies_history jsonb;
alter table portfolios add column if not exists sharesies_synced_at timestamptz;
-- Set the moment Import portfolio succeeds, independent of whether the
-- history snapshot above also succeeded (it's a separate API call that can
-- fail on its own) — this is what Refresh checks to decide whether to
-- re-sync from Sharesies, so it can't be gated on sharesies_history alone.
alter table portfolios add column if not exists sharesies_linked boolean not null default false;
update portfolios set sharesies_linked = true where sharesies_history is not null;
-- A Sharesies account has several products (Invest, KiwiSaver, Save,
-- Wallet), each its own portfolio id (see getProducts in server/sharesies.js)
-- — this remembers which one THIS app portfolio was imported from, so
-- Refresh keeps pulling the right one instead of defaulting back to Invest.
alter table portfolios add column if not exists sharesies_portfolio_id text;
