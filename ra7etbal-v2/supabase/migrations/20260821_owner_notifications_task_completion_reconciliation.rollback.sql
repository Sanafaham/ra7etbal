/**
 * Rollback for 20260821_owner_notifications_task_completion_reconciliation.sql.
 *
 * Removes only the trigger and its function. No data was ever mutated by
 * the forward migration (it establishes future behavior only), so this
 * rollback is a pure schema removal with nothing to restore.
 */

DROP TRIGGER IF EXISTS reconcile_owner_notifications_on_task_done ON public.tasks;
DROP FUNCTION IF EXISTS public.reconcile_owner_notifications_on_task_done();
