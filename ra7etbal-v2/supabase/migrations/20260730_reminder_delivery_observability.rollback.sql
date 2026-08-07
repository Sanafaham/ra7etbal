drop table if exists public.reminder_delivery_events;
alter table public.tasks
  drop constraint if exists tasks_reminder_delivery_status_check,
  drop column if exists reminder_delivery_status,
  drop column if exists reminder_dispatch_attempted_at,
  drop column if exists reminder_provider_accepted_at,
  drop column if exists reminder_interacted_at,
  drop column if exists reminder_delivery_error;
