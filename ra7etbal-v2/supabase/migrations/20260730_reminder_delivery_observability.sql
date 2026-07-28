alter table public.tasks
  add column if not exists reminder_delivery_status text,
  add column if not exists reminder_dispatch_attempted_at timestamptz,
  add column if not exists reminder_provider_accepted_at timestamptz,
  add column if not exists reminder_interacted_at timestamptz,
  add column if not exists reminder_delivery_error text;

alter table public.tasks drop constraint if exists tasks_reminder_delivery_status_check;
alter table public.tasks add constraint tasks_reminder_delivery_status_check
  check (reminder_delivery_status is null or reminder_delivery_status in (
    'scheduled', 'dispatch_attempted', 'delivery_unconfirmed', 'failed', 'interacted'
  ));

create table if not exists public.reminder_delivery_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid,
  event_key text not null,
  stage text not null check (stage in (
    'scheduled', 'callback_received', 'provider_send_attempted',
    'provider_accepted', 'provider_rejected', 'service_worker_received',
    'show_notification_attempted', 'show_notification_resolved',
    'show_notification_failed', 'notification_clicked'
  )),
  event_at timestamptz not null default now(),
  provider_status_code integer,
  metadata jsonb not null default '{}'::jsonb,
  unique (task_id, event_key)
);

create index if not exists reminder_delivery_events_task_id_event_at_idx
  on public.reminder_delivery_events(task_id, event_at);

alter table public.reminder_delivery_events enable row level security;
drop policy if exists "Owners can read reminder delivery events" on public.reminder_delivery_events;
create policy "Owners can read reminder delivery events"
  on public.reminder_delivery_events for select
  to authenticated
  using (auth.uid() = user_id);

revoke insert, update, delete on public.reminder_delivery_events from anon, authenticated;
grant select on public.reminder_delivery_events to authenticated;
grant select, insert, update, delete on public.reminder_delivery_events to service_role;
