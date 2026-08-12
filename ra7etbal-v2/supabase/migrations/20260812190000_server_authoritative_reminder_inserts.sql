-- One-off reminders are server-authoritative. This restrictive policy composes
-- with the existing owner INSERT policy: authenticated clients retain their
-- current ability to create every non-reminder task type, but cannot directly
-- insert type='reminder'. Server routes use the service role and bypass RLS.
-- Existing rows are untouched; no backfill is required.
alter table public.tasks enable row level security;

create policy "tasks: reminders require server creation"
  on public.tasks
  as restrictive
  for insert
  to authenticated
  with check (type <> 'reminder');
