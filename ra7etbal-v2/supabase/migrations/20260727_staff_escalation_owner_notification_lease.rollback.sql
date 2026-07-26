/**
 * Rollback for 20260727_staff_escalation_owner_notification_lease.sql.
 *
 * Reverses the migration exactly: drops the three new functions, drops
 * the four new lease columns, and restores the original 4-value
 * owner_notification_status CHECK constraint (removing 'sending').
 * Nothing else on staff_messages — every other column, constraint, index,
 * RLS policy, and pre-existing function (claim_staff_message,
 * complete_staff_message, fail_staff_message, retry_staff_message,
 * claim_staff_response_delivery, complete_staff_response_delivery,
 * fail_staff_response_delivery) — is touched. The Phase A escalation
 * table and its own five functions (claim_escalation_owner_decision,
 * answer_escalation_owner_decision, claim_escalation_answer_delivery,
 * complete_escalation_answer_delivery, fail_escalation_answer_delivery)
 * are also untouched.
 */

DROP FUNCTION IF EXISTS public.fail_owner_escalation_notification(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.complete_owner_escalation_notification(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_owner_escalation_notification(uuid, uuid, integer);

-- Any row still 'sending' at rollback time (a genuinely in-flight
-- notification attempt — plausible in production, not just a test
-- artifact) cannot survive the narrower 4-value constraint restored below.
-- Resolve it to 'failed' rather than letting the rollback itself fail with
-- a check-constraint violation — the same safe, truthful terminal state
-- fail_owner_escalation_notification would have produced if the in-flight
-- attempt had been allowed to finish failing on its own.
UPDATE public.staff_messages
  SET owner_notification_status = 'failed',
      owner_notification_error = COALESCE(owner_notification_error, 'rolled_back_while_in_flight')
  WHERE owner_notification_status = 'sending';

ALTER TABLE public.staff_messages
  DROP COLUMN IF EXISTS owner_notification_token,
  DROP COLUMN IF EXISTS owner_notification_claimed_at,
  DROP COLUMN IF EXISTS owner_notification_lease_until,
  DROP COLUMN IF EXISTS owner_notification_error;

-- Restore the original 4-value constraint (drop 'sending').
ALTER TABLE public.staff_messages
  DROP CONSTRAINT IF EXISTS staff_messages_owner_notification_status_check;
ALTER TABLE public.staff_messages
  ADD CONSTRAINT staff_messages_owner_notification_status_check
  CHECK (owner_notification_status IN ('not_attempted','sent','skipped_no_phone','failed'));
