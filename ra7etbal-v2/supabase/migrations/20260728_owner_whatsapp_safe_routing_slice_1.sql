/**
 * Forward-only companion for the already-applied owner reply receipts.
 * Prepared for Slice 1; do not apply as part of branch validation.
 */

ALTER TABLE public.owner_whatsapp_reply_receipts
  ADD COLUMN IF NOT EXISTS inbound_text text,
  ADD COLUMN IF NOT EXISTS sender_phone text,
  ADD COLUMN IF NOT EXISTS phone_number_id text,
  ADD COLUMN IF NOT EXISTS context_message_id text,
  ADD COLUMN IF NOT EXISTS route text,
  ADD COLUMN IF NOT EXISTS execution_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS execution_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS execution_error text,
  ADD COLUMN IF NOT EXISTS acknowledgement_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS acknowledgement_text text,
  ADD COLUMN IF NOT EXISTS acknowledgement_transport_message_id text,
  ADD COLUMN IF NOT EXISTS acknowledgement_error text,
  ADD COLUMN IF NOT EXISTS staff_transport_message_id text,
  ADD COLUMN IF NOT EXISTS action_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS action_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_retries integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

ALTER TABLE public.owner_whatsapp_reply_receipts
  DROP CONSTRAINT IF EXISTS owner_whatsapp_reply_receipts_execution_status_check;
ALTER TABLE public.owner_whatsapp_reply_receipts
  ADD CONSTRAINT owner_whatsapp_reply_receipts_execution_status_check
  CHECK (execution_status IN ('pending','action_created','completed','failed','unsupported'));

ALTER TABLE public.owner_whatsapp_reply_receipts
  DROP CONSTRAINT IF EXISTS owner_whatsapp_reply_receipts_acknowledgement_status_check;
ALTER TABLE public.owner_whatsapp_reply_receipts
  ADD CONSTRAINT owner_whatsapp_reply_receipts_acknowledgement_status_check
  CHECK (acknowledgement_status IN ('pending','accepted','failed','terminal_failed'));

CREATE INDEX IF NOT EXISTS owner_whatsapp_reply_receipts_retry_idx
  ON public.owner_whatsapp_reply_receipts (next_retry_at)
  WHERE status = 'failed';

ALTER TABLE public.owner_whatsapp_reply_receipts
  DROP CONSTRAINT IF EXISTS owner_whatsapp_reply_receipts_outcome_check;
ALTER TABLE public.owner_whatsapp_reply_receipts
  ADD CONSTRAINT owner_whatsapp_reply_receipts_outcome_check
  CHECK (outcome IS NULL OR outcome IN (
    'resolved_escalation',
    'clarification_sent',
    'zero_match',
    'general_command_executed',
    'unsupported_command'
  ));

CREATE OR REPLACE FUNCTION public.complete_owner_whatsapp_reply(
  p_id            uuid,
  p_user_id       uuid,
  p_claim_token   uuid,
  p_outcome       text,
  p_escalation_id uuid DEFAULT NULL
) RETURNS public.owner_whatsapp_reply_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.owner_whatsapp_reply_receipts;
BEGIN
  IF p_outcome NOT IN (
    'resolved_escalation',
    'clarification_sent',
    'zero_match',
    'general_command_executed',
    'unsupported_command'
  ) THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023';
  END IF;

  UPDATE public.owner_whatsapp_reply_receipts SET
    status = 'completed',
    outcome = p_outcome,
    escalation_id = p_escalation_id,
    completed_at = now(),
    claim_token = NULL,
    lease_until = NULL,
    error = NULL
  WHERE id = p_id
    AND user_id = p_user_id
    AND status = 'claimed'
    AND claim_token = p_claim_token
  RETURNING * INTO v;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_receipt_claim' USING ERRCODE = '40001';
  END IF;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_owner_whatsapp_reply(uuid, uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_owner_whatsapp_reply(uuid, uuid, uuid, text, uuid)
  TO service_role;

ALTER TABLE public.staff_escalation_owner_decisions
  DROP CONSTRAINT IF EXISTS staff_escalation_owner_decisions_owner_reply_channel_check;
ALTER TABLE public.staff_escalation_owner_decisions
  ADD CONSTRAINT staff_escalation_owner_decisions_owner_reply_channel_check
  CHECK (owner_reply_channel IS NULL OR owner_reply_channel IN ('app', 'whatsapp'));

DROP FUNCTION IF EXISTS public.answer_escalation_owner_decision(uuid, text);

CREATE OR REPLACE FUNCTION public.answer_escalation_owner_decision(
  p_deep_link_token    uuid,
  p_owner_reply_text   text,
  p_owner_reply_channel text DEFAULT 'app'
) RETURNS public.staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.staff_escalation_owner_decisions;
  v_channel text := lower(NULLIF(btrim(p_owner_reply_channel), ''));
BEGIN
  IF p_owner_reply_text IS NULL OR btrim(p_owner_reply_text) = '' THEN
    RAISE EXCEPTION 'empty_reply' USING ERRCODE = '22023';
  END IF;
  IF v_channel IS NULL OR v_channel NOT IN ('app', 'whatsapp') THEN
    RAISE EXCEPTION 'invalid_reply_channel' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.staff_escalation_owner_decisions
    WHERE deep_link_token = p_deep_link_token
    FOR UPDATE;
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
        owner_reply_channel = v_channel,
        answered_at = now()
    WHERE id = v.id
    RETURNING * INTO v;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.answer_escalation_owner_decision(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.answer_escalation_owner_decision(uuid, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_owner_whatsapp_command(
  p_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_inbound_text text,
  p_sender_phone text,
  p_phone_number_id text,
  p_context_message_id text,
  p_route text
) RETURNS public.owner_whatsapp_reply_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.owner_whatsapp_reply_receipts;
BEGIN
  IF NULLIF(btrim(p_inbound_text), '') IS NULL OR length(p_inbound_text) > 2000 THEN
    RAISE EXCEPTION 'invalid_command_text' USING ERRCODE = '22023';
  END IF;
  IF p_route NOT IN ('direct_message','delegation','reminder','unsupported','quoted_escalation') THEN
    RAISE EXCEPTION 'invalid_command_route' USING ERRCODE = '22023';
  END IF;
  UPDATE public.owner_whatsapp_reply_receipts SET
    inbound_text = COALESCE(inbound_text, p_inbound_text),
    sender_phone = COALESCE(sender_phone, p_sender_phone),
    phone_number_id = COALESCE(phone_number_id, p_phone_number_id),
    context_message_id = COALESCE(context_message_id, p_context_message_id),
    route = COALESCE(route, p_route),
    execution_status = CASE WHEN execution_status = 'failed' THEN 'pending' ELSE execution_status END,
    retry_count = retry_count + 1,
    next_retry_at = NULL
  WHERE id = p_id AND user_id = p_user_id AND status = 'claimed' AND claim_token = p_claim_token
  RETURNING * INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_receipt_claim' USING ERRCODE = '40001';
  END IF;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_owner_whatsapp_command(uuid, uuid, uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_owner_whatsapp_command(uuid, uuid, uuid, text, text, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_accepted_escalation_answer_delivery(
  p_id uuid,
  p_user_id uuid,
  p_transport_message_id text
) RETURNS public.staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.staff_escalation_owner_decisions;
  v_now timestamptz := now();
BEGIN
  IF NULLIF(btrim(p_transport_message_id), '') IS NULL THEN
    RAISE EXCEPTION 'missing_transport_message_id' USING ERRCODE = '22023';
  END IF;
  UPDATE public.staff_escalation_owner_decisions SET
    status = 'delivered_to_staff',
    delivered_at = COALESCE(delivered_at, v_now),
    delivery_token = NULL,
    delivery_lease_until = NULL,
    delivery_error = NULL
  WHERE id = p_id AND user_id = p_user_id
    AND status IN ('answered','delivering','delivered_to_staff')
  RETURNING * INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_reconciliation_state' USING ERRCODE = '22023';
  END IF;
  UPDATE public.staff_messages SET
    user_facing_state = 'Completed',
    escalation_resolved_at = COALESCE(escalation_resolved_at, v_now)
  WHERE id = v.staff_message_id AND user_id = p_user_id;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reconcile_accepted_escalation_answer_delivery(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_accepted_escalation_answer_delivery(uuid, uuid, text)
  TO service_role;
