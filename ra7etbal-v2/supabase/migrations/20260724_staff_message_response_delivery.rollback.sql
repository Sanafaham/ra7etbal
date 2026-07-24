DROP FUNCTION IF EXISTS public.claim_staff_response_delivery(uuid,uuid,integer);
DROP FUNCTION IF EXISTS public.complete_staff_response_delivery(uuid,uuid,uuid,text,timestamptz);
DROP FUNCTION IF EXISTS public.fail_staff_response_delivery(uuid,uuid,uuid,text,timestamptz);

CREATE OR REPLACE FUNCTION public.complete_staff_message(
  p_id                       uuid,
  p_user_id                  uuid,
  p_classification           text,
  p_carson_response          text,
  p_next_action_owner        text,
  p_user_facing_state        text,
  p_owner_attention_required boolean,
  p_escalation_reason        text,
  p_responded_at             timestamptz
) RETURNS public.staff_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_current public.staff_messages;
  v_row     public.staff_messages;
BEGIN
  SELECT * INTO v_current FROM public.staff_messages
    WHERE id = p_id AND user_id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  IF v_current.processing_status = 'completed' THEN
    RETURN v_current;
  END IF;

  IF v_current.processing_status <> 'claimed' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_messages SET
    classification = p_classification,
    carson_response = p_carson_response,
    next_action_owner = p_next_action_owner,
    user_facing_state = p_user_facing_state,
    owner_attention_required = p_owner_attention_required,
    escalation_reason = p_escalation_reason,
    responded_at = p_responded_at,
    processing_status = 'completed'
  WHERE id = p_id AND user_id = p_user_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

ALTER TABLE public.staff_messages
  DROP COLUMN IF EXISTS response_delivery_status,
  DROP COLUMN IF EXISTS response_delivery_attempts,
  DROP COLUMN IF EXISTS response_delivery_token,
  DROP COLUMN IF EXISTS response_delivery_claimed_at,
  DROP COLUMN IF EXISTS response_delivery_lease_until,
  DROP COLUMN IF EXISTS response_delivered_at,
  DROP COLUMN IF EXISTS response_delivery_failed_at,
  DROP COLUMN IF EXISTS response_delivery_error,
  DROP COLUMN IF EXISTS response_transport_message_id;
