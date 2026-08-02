/**
 * Rollback for 20260726_staff_escalation_owner_decisions.sql.
 *
 * Reverses the migration exactly: drops the five new functions, the update
 * trigger and its function, the new table (CASCADE drops its indexes/RLS
 * policies automatically), and the three additive staff_messages columns.
 * Nothing else on staff_messages — its existing columns, constraints,
 * indexes, RLS policies, and claim_staff_message/complete_staff_message/
 * fail_staff_message/retry_staff_message/claim_staff_response_delivery/
 * complete_staff_response_delivery/fail_staff_response_delivery functions
 * — is touched.
 */

DROP TRIGGER IF EXISTS set_staff_escalation_owner_decisions_updated_at ON public.staff_escalation_owner_decisions;
DROP FUNCTION IF EXISTS public.set_staff_escalation_owner_decisions_updated_at();

DROP FUNCTION IF EXISTS public.fail_escalation_answer_delivery(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.complete_escalation_answer_delivery(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_escalation_answer_delivery(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.answer_escalation_owner_decision(uuid, text);
DROP FUNCTION IF EXISTS public.claim_escalation_owner_decision(uuid, uuid, uuid);

DROP TABLE IF EXISTS public.staff_escalation_owner_decisions;

ALTER TABLE public.staff_messages
  DROP COLUMN IF EXISTS owner_notification_status,
  DROP COLUMN IF EXISTS owner_notified_at,
  DROP COLUMN IF EXISTS escalation_resolved_at;
