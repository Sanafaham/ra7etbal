/**
 * Owner Notification Reconciliation on Task Completion.
 *
 * Root cause (reproduced in production, 2026-08-21): a task's actionable
 * owner_notifications row (task_escalation, reminder_due, routine_reminder,
 * task_review_followup, automation_reminder) is never dismissed when the
 * task it refers to resolves. api/task-confirm.js and api/qstash-reminder.js
 * only ever create a fresh, separate completion notification — nothing
 * reconciles the earlier actionable one. Worse, the owner's own "Mark Done"
 * action (src/lib/tasks.ts:updateTask, a direct client-side Supabase write)
 * has no server-side hook at all, so any fix confined to API routes cannot
 * cover it. A database trigger on public.tasks is therefore the only
 * mechanism that structurally covers every current and future resolution
 * path, regardless of which code performs the UPDATE.
 *
 * Invariant: when a task genuinely transitions INTO status = 'done' (never
 * on INSERT, never re-firing for a task that is already done being
 * updated again), soft-dismiss only the still-open owner_notifications
 * rows that were an actionable request about that exact task. Historical/
 * informational kinds (task_completed, task_<variant>, routine_message_sent)
 * are never touched — they are the truthful record that the resolution
 * happened, not a stale open ask. Unknown/future kinds fail safe (left
 * untouched) because the allowlist is positive, not a denylist.
 *
 * Timestamp: dismissed_at = COALESCE(NEW.confirmed_at, now()). Every
 * currently-known status='done' write path (api/task-confirm.js x2,
 * api/qstash-reminder.js, src/lib/tasks.ts's client update) sets
 * confirmed_at in the same write as status, and production data confirms
 * zero existing rows with status='done' AND confirmed_at IS NULL — but
 * confirmed_at is nullable at the schema level, so this is not a hard
 * database guarantee. NEW.confirmed_at is preferred (it is the task's own
 * truthful resolution moment, matching the existing philosophy in
 * api/_automation-run-confirmation-sync.js of never inventing a timestamp
 * and always deferring to the task's own canonical value). now() is used
 * only as a fallback, and only represents the real moment the reconciling
 * write itself happens — never a fabricated past time.
 *
 * Tenant isolation: the UPDATE filters on user_id = NEW.user_id in
 * addition to target_type/target_id, so even a corrupted or colliding
 * target_id could never cause a cross-account dismissal.
 *
 * Idempotency: dismissed_at IS NULL is part of the UPDATE's WHERE clause,
 * matching the existing dismissOwnerNotification() guard — a second
 * reconciliation attempt, a repeated update to an already-done task, or a
 * concurrent completion race are all no-ops beyond the first successful
 * dismissal.
 *
 * This migration establishes behavior for FUTURE qualifying task
 * transitions only. It performs no backfill and mutates no existing row —
 * the three historically-stale production notifications already found and
 * manually reconciled during the prior audit are untouched by applying
 * this migration.
 */

CREATE OR REPLACE FUNCTION public.reconcile_owner_notifications_on_task_done()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only a genuine transition INTO 'done' reconciles anything. A task
  -- that is already 'done' being updated again (e.g. a later field edit)
  -- must never re-fire this, and no other status change is in scope.
  IF NEW.status = 'done' AND (OLD.status IS DISTINCT FROM 'done') THEN
    UPDATE public.owner_notifications
    SET dismissed_at = COALESCE(NEW.confirmed_at, now())
    WHERE target_type = 'task'
      AND target_id = NEW.id
      AND user_id = NEW.user_id
      AND dismissed_at IS NULL
      AND kind = ANY (ARRAY[
        'task_escalation',
        'reminder_due',
        'routine_reminder',
        'task_review_followup',
        'automation_reminder'
      ]::text[]);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reconcile_owner_notifications_on_task_done ON public.tasks;

CREATE TRIGGER reconcile_owner_notifications_on_task_done
  AFTER UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.reconcile_owner_notifications_on_task_done();
