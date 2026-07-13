-- Clear My Head and the internal Inbox surface were removed from the
-- product. This backfills the remaining clear_my_head_inbox rows into
-- carson_notes (their content is non-actionable, thought-shaped text —
-- exactly what Notes is for) so nothing the user saved is lost when the
-- Clear My Head Inbox UI disappears.
--
-- Idempotency is keyed to the source row's own primary key (migrated_at),
-- not to matching user_id/text — two distinct rows with identical text
-- must both survive migration exactly once each, never collapse into one
-- note. Re-running this migration is a no-op once a row's migrated_at is
-- set.
--
-- The clear_my_head_inbox table itself is intentionally left in place
-- (unused, no longer read by any route) rather than dropped, per the
-- product-removal task's data-safety rule against irreversible schema
-- changes without explicit approval.

alter table public.clear_my_head_inbox
  add column if not exists migrated_at timestamptz;

insert into carson_notes (user_id, note, category, source, created_at)
select c.user_id, c.text, 'general', 'clear_my_head_migration', c.created_at
from clear_my_head_inbox c
where c.migrated_at is null;

update clear_my_head_inbox
set migrated_at = now()
where migrated_at is null;
