-- Migration: lets a user paste their own free Finnhub API key, so their
-- portfolio holdings get refreshed on their own 60-calls/min budget instead
-- of sharing the app's single server-wide key with every other user. Run
-- once in the Supabase SQL editor (Dashboard -> SQL -> New query). Safe to
-- run on an existing database.

create table if not exists user_settings (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  finnhub_key text
);

alter table user_settings enable row level security;
drop policy if exists "own settings" on user_settings;
create policy "own settings" on user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
