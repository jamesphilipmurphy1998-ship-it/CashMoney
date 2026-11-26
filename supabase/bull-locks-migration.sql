-- Migration: lets a user "lock" a Bull/Standard/Bear case calculator
-- projection so it persists (across refreshes, logouts/logins, devices)
-- instead of living only in the page's in-memory state. Keyed by
-- "TICKER::case" since a user may want more than one locked at once (even
-- multiple cases for the same ticker); each snapshot is stored as jsonb so
-- the shape can evolve without another migration. Run once in the Supabase
-- SQL editor. Safe to run on an existing database.

alter table user_settings add column if not exists bull_locks jsonb not null default '{}'::jsonb;
