-- Carson Weekly Planning V1 reuses carson_pending_operations (the existing
-- propose → single approval → execute state machine built for guest-arrival
-- household ops) for the "organize my week" flow, instead of a new table.
-- Widens the type check constraint to also allow 'weekly_plan'. Additive
-- only — no data loss, fully backward compatible with existing
-- 'guest_arrival' rows.

alter table public.carson_pending_operations
  drop constraint if exists carson_pending_operations_type_check;

alter table public.carson_pending_operations
  add constraint carson_pending_operations_type_check
  check (type = any (array['guest_arrival', 'weekly_plan']));
