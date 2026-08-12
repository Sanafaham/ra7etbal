/**
 * Rollback for 20260812_reminder_delivery_events_survive_task_deletion.sql.
 *
 * Only safe to run if no row currently has a NULL task_id (i.e. no task
 * deletion has happened since the forward migration applied) -- re-adding
 * NOT NULL will fail otherwise. Check first:
 *   select count(*) from public.reminder_delivery_events where task_id is null;
 */

alter table public.reminder_delivery_events
  drop constraint reminder_delivery_events_task_id_fkey;

alter table public.reminder_delivery_events
  alter column task_id set not null;

alter table public.reminder_delivery_events
  add constraint reminder_delivery_events_task_id_fkey
    foreign key (task_id) references public.tasks(id) on delete cascade;
