-- Migration: daily snapshot of the "Portfolio's summary" total value, so its
-- growth chart has history. Run this once in the Supabase SQL editor
-- (Dashboard -> SQL -> New query). Safe to run on an existing database.

create table if not exists summary_history (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date       date not null,
  value      numeric not null,
  primary key (user_id, date)
);

alter table summary_history enable row level security;
drop policy if exists "own summary history" on summary_history;
create policy "own summary history" on summary_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
