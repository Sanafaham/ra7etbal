/**
 * Owner completion push reliability — evidence retention fix.
 *
 * reminder_delivery_events.task_id was `not null references tasks(id) on
 * delete cascade` (20260730_reminder_delivery_observability.sql). CASCADE
 * means the evidence ROW ITSELF is deleted, not just orphaned, whenever its
 * task is deleted (Clear History bulk-deletes done tasks; voice "delete
 * that task" deletes a single one). A just-completed task is exactly the
 * kind most likely to be cleared soon after completion, so this would
 * silently destroy the owner-completion-push diagnostic history the new
 * capability depends on -- the same durability defect class already fixed
 * for staff_escalation_owner_decisions/whatsapp_deliveries.person_id
 * (PR #235/#237), applied here via the identical precedent: relax the
 * cascade to SET NULL so the row survives, keyed by the already-durable,
 * already-NOT-NULL user_id column instead.
 *
 * Verified safe against every current reader before writing this:
 *   - carson-commitment-history.ts only queries this table for a task that
 *     is still loaded by id (task.type === 'reminder' gate) -- a deleted
 *     task can't reach this code path at all, so task_id going nullable
 *     changes nothing for it.
 *   - push-notifications.ts's listPushSubscriptionDevices() filters only by
 *     user_id + subscription_id + stage, never task_id -- unaffected, and
 *     benefits: "last delivered" evidence for a device no longer silently
 *     disappears every time a completed task's history is cleared.
 *   - unique(task_id, event_key) is unaffected: Postgres treats each NULL
 *     task_id as distinct for uniqueness purposes, and no new events are
 *     ever written against a task after it's deleted, so no realistic
 *     collision.
 *
 * Additive/backward-compatible: existing rows keep their task_id unchanged;
 * only future deletions behave differently (row survives, task_id -> NULL,
 * instead of the row vanishing).
 */

alter table public.reminder_delivery_events
  drop constraint reminder_delivery_events_task_id_fkey;

alter table public.reminder_delivery_events
  alter column task_id drop not null;

alter table public.reminder_delivery_events
  add constraint reminder_delivery_events_task_id_fkey
    foreign key (task_id) references public.tasks(id) on delete set null;
