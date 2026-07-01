-- Portfolio tracker schema — multi-user with login.
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- Each row belongs to a user (user_id = the logged-in account). Row-level
-- security makes the database itself enforce that a user can only ever read
-- or write their own rows — even though the browser uses the public key.

-- ── positions ───────────────────────────────────────────────────────────
create table if not exists positions (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  ticker     text not null,
  shares     numeric not null default 0,
  cost       numeric not null default 0,
  price      numeric not null default 0,
  day        numeric not null default 0,
  category   text default '',
  updated_at timestamptz not null default now()
);

-- ── notes ───────────────────────────────────────────────────────────────
create table if not exists notes (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null,
  body       text default '',
  updated_at timestamptz not null default now()
);

-- ── row-level security ──────────────────────────────────────────────────
alter table positions enable row level security;
alter table notes     enable row level security;

-- One policy per table: you may do anything to rows that are yours, and the
-- database forces new rows to be stamped with your id.
create policy "own positions" on positions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own notes" on notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
