/** Atomic, retryable send guard for task-review owner notifications. */

ALTER TABLE public.staff_escalation_owner_decisions
  ADD COLUMN IF NOT EXISTS owner_notification_status text,
  ADD COLUMN IF NOT EXISTS owner_notification_token uuid,
  ADD COLUMN IF NOT EXISTS owner_notification_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS owner_notification_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS owner_notification_meta_message_id text,
  ADD COLUMN IF NOT EXISTS owner_notification_error text;

ALTER TABLE public.staff_escalation_owner_decisions
  DROP CONSTRAINT IF EXISTS staff_escalation_owner_decisions_owner_notification_status_check;
ALTER TABLE public.staff_escalation_owner_decisions
  ADD CONSTRAINT staff_escalation_owner_decisions_owner_notification_status_check
  CHECK (owner_notification_status IS NULL OR owner_notification_status IN ('sending','sent','failed','reconciliation_required'));

CREATE OR REPLACE FUNCTION public.claim_task_review_owner_notification(
  p_id uuid,
  p_user_id uuid,
  p_lease_seconds integer DEFAULT 120
) RETURNS TABLE (
  decision_id uuid,
  claimed boolean,
  claim_token uuid,
  notification_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.staff_escalation_owner_decisions;
  v_token uuid := gen_random_uuid();
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.staff_escalation_owner_decisions
    WHERE id = p_id AND user_id = p_user_id AND staff_message_id IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  -- Legacy rows only had owner_notified_at. Preserve their terminal state.
  IF v.owner_notified_at IS NOT NULL OR v.owner_notification_status = 'sent' THEN
    RETURN QUERY SELECT v.id, false, NULL::uuid, 'sent'::text;
    RETURN;
  END IF;

  -- An expired in-flight send has an unknown provider outcome. Fail closed:
  -- preserve it for explicit reconciliation rather than risking a duplicate.
  IF v.owner_notification_status = 'sending' AND v.owner_notification_lease_until <= now() THEN
    UPDATE public.staff_escalation_owner_decisions SET
      owner_notification_status = 'reconciliation_required',
      owner_notification_token = NULL,
      owner_notification_lease_until = NULL,
      owner_notification_error = 'expired_send_outcome_unknown'
    WHERE id = p_id
    RETURNING * INTO v;
    RETURN QUERY SELECT v.id, false, NULL::uuid, v.owner_notification_status;
    RETURN;
  END IF;

  IF v.owner_notification_status IS NULL OR v.owner_notification_status = 'failed' THEN
    UPDATE public.staff_escalation_owner_decisions SET
      owner_notification_status = 'sending',
      owner_notification_token = v_token,
      owner_notification_claimed_at = now(),
      owner_notification_lease_until = now() + make_interval(secs => p_lease_seconds),
      owner_notification_error = NULL
    WHERE id = p_id
    RETURNING * INTO v;
    RETURN QUERY SELECT v.id, true, v_token, v.owner_notification_status;
    RETURN;
  END IF;

  RETURN QUERY SELECT v.id, false, NULL::uuid, v.owner_notification_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_task_review_owner_notification(
  p_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_meta_message_id text
) RETURNS public.staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.staff_escalation_owner_decisions;
BEGIN
  UPDATE public.staff_escalation_owner_decisions SET
    owner_notification_status = 'sent',
    owner_notified_at = now(),
    owner_notification_token = NULL,
    owner_notification_lease_until = NULL,
    owner_notification_meta_message_id = NULLIF(btrim(p_meta_message_id), ''),
    owner_notification_error = NULL
  WHERE id = p_id AND user_id = p_user_id
    AND staff_message_id IS NULL
    AND owner_notification_status = 'sending'
    AND owner_notification_token = p_claim_token
  RETURNING * INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_notification_claim' USING ERRCODE = '40001';
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_task_review_owner_notification(
  p_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_meta_message_id text
) RETURNS public.staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.staff_escalation_owner_decisions;
BEGIN
  UPDATE public.staff_escalation_owner_decisions SET
    owner_notification_status = 'reconciliation_required',
    owner_notification_token = NULL,
    owner_notification_lease_until = NULL,
    owner_notification_meta_message_id = NULLIF(btrim(p_meta_message_id), ''),
    owner_notification_error = 'meta_accepted_completion_unknown'
  WHERE id = p_id AND user_id = p_user_id
    AND staff_message_id IS NULL
    AND owner_notification_status = 'sending'
    AND owner_notification_token = p_claim_token
  RETURNING * INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_notification_claim' USING ERRCODE = '40001';
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_task_review_owner_notification(
  p_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_error text
) RETURNS public.staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.staff_escalation_owner_decisions;
BEGIN
  UPDATE public.staff_escalation_owner_decisions SET
    owner_notification_status = 'failed',
    owner_notification_error = left(NULLIF(btrim(p_error), ''), 500),
    owner_notification_token = NULL,
    owner_notification_lease_until = NULL
  WHERE id = p_id AND user_id = p_user_id
    AND staff_message_id IS NULL
    AND owner_notification_status = 'sending'
    AND owner_notification_token = p_claim_token
  RETURNING * INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_notification_claim' USING ERRCODE = '40001';
  END IF;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_task_review_owner_notification(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_task_review_owner_notification(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reconcile_task_review_owner_notification(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_task_review_owner_notification(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_task_review_owner_notification(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_task_review_owner_notification(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_task_review_owner_notification(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_task_review_owner_notification(uuid, uuid, uuid, text) TO service_role;
