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
