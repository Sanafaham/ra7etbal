/*
 * Coordinated rollback only: deploy code that no longer supplies the reply
 * channel or reads command-state columns before applying this file.
 *
 * This preflight intentionally runs before any schema change. New channel or
 * command outcome rows contain audit truth that cannot be losslessly coerced
 * to the old schema, so rollback fails clearly instead of partially mutating
 * or silently rewriting production history.
 */
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.staff_escalation_owner_decisions
    WHERE owner_reply_channel = 'whatsapp'
  ) THEN
    RAISE EXCEPTION 'rollback_blocked: whatsapp owner reply audit rows exist; coordinate an explicit archival strategy';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.owner_whatsapp_reply_receipts
    WHERE outcome IN ('general_command_executed', 'unsupported_command', 'general_command_deferred')
       OR inbound_text IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'rollback_blocked: owner command audit rows exist; coordinate an explicit archival strategy';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.record_owner_whatsapp_command(uuid, uuid, uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.reconcile_accepted_escalation_answer_delivery(uuid, uuid, text);

DROP FUNCTION IF EXISTS public.answer_escalation_owner_decision(uuid, text, text);

CREATE OR REPLACE FUNCTION public.answer_escalation_owner_decision(
  p_deep_link_token uuid,
  p_owner_reply_text text
) RETURNS public.staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.staff_escalation_owner_decisions;
BEGIN
  IF p_owner_reply_text IS NULL OR btrim(p_owner_reply_text) = '' THEN
    RAISE EXCEPTION 'empty_reply' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v FROM public.staff_escalation_owner_decisions
    WHERE deep_link_token = p_deep_link_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;
  IF v.status IN ('answered', 'delivering', 'delivered_to_staff') THEN
    RETURN v;
  END IF;
  IF v.status <> 'open' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';
  END IF;
  UPDATE public.staff_escalation_owner_decisions
    SET status = 'answered',
        owner_reply_text = btrim(p_owner_reply_text),
        owner_reply_channel = 'app',
        answered_at = now()
    WHERE id = v.id RETURNING * INTO v;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.answer_escalation_owner_decision(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.answer_escalation_owner_decision(uuid, text)
  TO service_role;

ALTER TABLE public.staff_escalation_owner_decisions
  DROP CONSTRAINT IF EXISTS staff_escalation_owner_decisions_owner_reply_channel_check;
ALTER TABLE public.staff_escalation_owner_decisions
  ADD CONSTRAINT staff_escalation_owner_decisions_owner_reply_channel_check
  CHECK (owner_reply_channel IS NULL OR owner_reply_channel IN ('app'));

CREATE OR REPLACE FUNCTION public.complete_owner_whatsapp_reply(
  p_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_escalation_id uuid DEFAULT NULL
) RETURNS public.owner_whatsapp_reply_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.owner_whatsapp_reply_receipts;
BEGIN
  IF p_outcome NOT IN ('resolved_escalation', 'clarification_sent', 'zero_match') THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023';
  END IF;
  UPDATE public.owner_whatsapp_reply_receipts SET
    status = 'completed', outcome = p_outcome, escalation_id = p_escalation_id,
    completed_at = now(), claim_token = NULL, lease_until = NULL, error = NULL
  WHERE id = p_id AND user_id = p_user_id AND status = 'claimed'
    AND claim_token = p_claim_token
  RETURNING * INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_receipt_claim' USING ERRCODE = '40001';
  END IF;
  RETURN v;
END;
$$;

ALTER TABLE public.owner_whatsapp_reply_receipts
  DROP CONSTRAINT IF EXISTS owner_whatsapp_reply_receipts_outcome_check;
ALTER TABLE public.owner_whatsapp_reply_receipts
  ADD CONSTRAINT owner_whatsapp_reply_receipts_outcome_check
  CHECK (outcome IS NULL OR outcome IN (
    'resolved_escalation', 'clarification_sent', 'zero_match'
  ));

DROP INDEX IF EXISTS public.owner_whatsapp_reply_receipts_retry_idx;

ALTER TABLE public.owner_whatsapp_reply_receipts
  DROP COLUMN IF EXISTS inbound_text,
  DROP COLUMN IF EXISTS sender_phone,
  DROP COLUMN IF EXISTS phone_number_id,
  DROP COLUMN IF EXISTS context_message_id,
  DROP COLUMN IF EXISTS route,
  DROP COLUMN IF EXISTS execution_status,
  DROP COLUMN IF EXISTS execution_result,
  DROP COLUMN IF EXISTS execution_error,
  DROP COLUMN IF EXISTS acknowledgement_status,
  DROP COLUMN IF EXISTS acknowledgement_transport_message_id,
  DROP COLUMN IF EXISTS acknowledgement_error,
  DROP COLUMN IF EXISTS staff_transport_message_id,
  DROP COLUMN IF EXISTS action_task_id,
  DROP COLUMN IF EXISTS action_message_id,
  DROP COLUMN IF EXISTS retry_count,
  DROP COLUMN IF EXISTS max_retries,
  DROP COLUMN IF EXISTS next_retry_at;
