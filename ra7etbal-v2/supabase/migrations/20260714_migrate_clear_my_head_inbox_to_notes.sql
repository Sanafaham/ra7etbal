-- Clear My Head and the internal Inbox surface were removed from the
-- product. This backfills the remaining clear_my_head_inbox rows into
-- carson_notes (their content is non-actionable, thought-shaped text —
-- exactly what Notes is for) so nothing the user saved is lost when the
-- Clear My Head Inbox UI disappears.
--
-- Idempotent: the NOT EXISTS guard means re-running this migration is a
-- no-op once a row has already been migrated (matched on user_id + note
-- text + the 'clear_my_head_migration' source marker).
--
-- The clear_my_head_inbox table itself is intentionally left in place
-- (unused, no longer read by any route) rather than dropped, per the
-- product-removal task's data-safety rule against irreversible schema
-- changes without explicit approval.

insert into carson_notes (user_id, note, category, source, created_at)
select c.user_id, c.text, 'general', 'clear_my_head_migration', c.created_at
from clear_my_head_inbox c
where not exists (
  select 1 from carson_notes n
  where n.user_id = c.user_id
    and n.note = c.text
    and n.source = 'clear_my_head_migration'
);
