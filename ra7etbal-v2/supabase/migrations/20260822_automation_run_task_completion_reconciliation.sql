/**
 * Automation Run Reconciliation on Task Completion.
 *
 * Root cause (reproduced in production, 2026-08-22): tasks.status is
 * canonical; automation_runs.current_state is a one-way projection of it
 * (see api/_automation-run-confirmation-sync.js's own doc comment). That
 * projection is currently performed only by
 * synchronizeAutomationRunFromConfirmedTask(), called from exactly one
 * place: api/task-confirm.js. Two other legitimate task-completion paths
 * bypass it entirely: api/qstash-reminder.js's notification-click
 * completion, and the owner's own "Mark Done" action
 * (src/lib/tasks.ts:updateTask, a direct client-side Supabase write with
 * no server hook at all). Read-only production audit (2026-08-22) found
 * 94 real rows where tasks.status='done' but the linked automation_runs
 * row is still stuck at current_state='sent', none of them possessing a
 * confirmations-table row (proving none went through the one path that
 * already performs this projection). A database trigger on public.tasks
 * is therefore the only mechanism that structurally covers every current
 * and future resolution path, regardless of which code performs the
 * UPDATE — the same shape of gap, and the same repair shape, as
 * 20260821_owner_notifications_task_completion_reconciliation.sql.
 *
 * Invariant: when a task genuinely transitions INTO status = 'done'
 * (never on INSERT, never re-firing for a task that is already done
 * being updated again), and exactly one linked automation_runs row is
 * still in a state the existing helper considers confirmable, project
 * that confirmation onto the run. Source-state allowlist and protected
 * terminal states are copied verbatim from
 * api/_automation-run-confirmation-sync.js's CONFIRMABLE_RUN_STATES /
 * PROTECTED_RUN_STATES so this trigger can never diverge from the
 * server-side helper's own contract.
 *
 * Timestamp: automation_runs.confirmed_at = NEW.confirmed_at, with no
 * fallback to now(). This intentionally differs from the owner_notifications
 * trigger's COALESCE(..., now()) — the existing JS helper's own contract
 * (`task.status !== 'done' || !task.confirmed_at` -> refuse to
 * synchronize) never invents a timestamp and simply declines to act when
 * confirmed_at is absent, so this trigger fails closed (no-op) the same
 * way rather than fabricating a substitute timestamp the helper itself
 * would never produce.
 *
 * Ambiguity safety: the existing helper explicitly refuses to act when
 * more than one automation_runs row matches a task
 * ("multiple_matching_runs", failing closed rather than guessing). This
 * trigger reproduces that: it counts eligible rows first and only
 * updates when the count is exactly 1. Zero or multiple eligible rows
 * both result in a no-op, never a guess and never an update-all.
 *
 * Tenant isolation: matched on task_id = NEW.id AND user_id = NEW.user_id
 * together, so a corrupted or colliding task_id could never cause a
 * cross-account projection.
 *
 * Idempotency: the source-state allowlist itself is the idempotency
 * guard — once a run reaches 'confirmed' (or any other protected
 * terminal state), it is no longer an eligible source row, so a second
 * transition, a repeated update to an already-done task, or a concurrent
 * completion race are all no-ops beyond the first successful projection.
 *
 * SECURITY DEFINER is required, not merely conventional here: automation_runs
 * has no UPDATE grant at all for the `authenticated` role (only a SELECT
 * policy), so a SECURITY INVOKER trigger would silently no-op on the
 * client-side Mark Done path — exactly the path this migration exists to
 * cover.
 *
 * This migration establishes behavior for FUTURE qualifying task
 * transitions only. It performs no backfill and mutates no existing row —
 * the 94 already-stale production rows found during the read-only audit
 * are untouched by applying this migration and remain a separate,
 * explicitly deferred cleanup decision.
 */

CREATE OR REPLACE FUNCTION public.reconcile_automation_run_on_task_done()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eligible_count integer;
  v_run_ids uuid[];
BEGIN
  -- Only a genuine transition INTO 'done' reconciles anything, and only
  -- when the task carries its own truthful confirmed_at -- never invent
  -- one, matching the existing JS helper's own refusal to act without it.
  IF NEW.status = 'done'
     AND (OLD.status IS DISTINCT FROM 'done')
     AND NEW.confirmed_at IS NOT NULL THEN

    SELECT count(*), array_agg(id)
      INTO v_eligible_count, v_run_ids
      FROM public.automation_runs
     WHERE task_id = NEW.id
       AND user_id = NEW.user_id
       AND current_state = ANY (ARRAY[
         'task_created',
         'sent',
         'followup_sent',
         'escalated',
         'failed'
       ]::text[]);

    -- Exactly one eligible run: project the confirmation. Zero or more
    -- than one: fail closed, never guess, never update multiple rows.
    IF v_eligible_count = 1 THEN
      UPDATE public.automation_runs
         SET current_state = 'confirmed',
             confirmed_at = NEW.confirmed_at
       WHERE id = v_run_ids[1]
         AND task_id = NEW.id
         AND user_id = NEW.user_id
         AND current_state = ANY (ARRAY[
           'task_created',
           'sent',
           'followup_sent',
           'escalated',
           'failed'
         ]::text[]);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reconcile_automation_run_on_task_done ON public.tasks;

CREATE TRIGGER reconcile_automation_run_on_task_done
  AFTER UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.reconcile_automation_run_on_task_done();
