DROP FUNCTION IF EXISTS public.fail_task_review_owner_notification(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.complete_task_review_owner_notification(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_task_review_owner_notification(uuid, uuid, integer);

ALTER TABLE public.staff_escalation_owner_decisions
  DROP CONSTRAINT IF EXISTS staff_escalation_owner_decisions_owner_notification_status_check;

ALTER TABLE public.staff_escalation_owner_decisions
  DROP COLUMN IF EXISTS owner_notification_error,
  DROP COLUMN IF EXISTS owner_notification_lease_until,
  DROP COLUMN IF EXISTS owner_notification_claimed_at,
  DROP COLUMN IF EXISTS owner_notification_token,
  DROP COLUMN IF EXISTS owner_notification_status;
