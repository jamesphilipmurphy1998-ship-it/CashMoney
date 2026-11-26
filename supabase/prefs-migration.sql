-- Migration: keeps the user's display preferences (theme, accent, tab/row
-- colours, portfolio and holdings order, linked portfolios, favourites, chart
-- formats, display currency, research list...) on their account instead of
-- only in one browser's localStorage, so they follow the user to every device
-- and survive clearing site data. One jsonb blob per user, keyed by the same
-- names the app already uses locally. Run once in the Supabase SQL editor.
-- Safe to run on an existing database.

alter table user_settings add column if not exists prefs jsonb not null default '{}'::jsonb;
