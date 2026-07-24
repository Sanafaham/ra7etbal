ALTER TABLE public.staff_messages
  ADD COLUMN response_delivery_status text NOT NULL DEFAULT 'not_required'
    CHECK (response_delivery_status IN ('not_required','pending','sending','delivered','failed')),
  ADD COLUMN response_delivery_attempts integer NOT NULL DEFAULT 0 CHECK (response_delivery_attempts >= 0),
  ADD COLUMN response_delivery_token uuid,
  ADD COLUMN response_delivery_claimed_at timestamptz,
  ADD COLUMN response_delivery_lease_until timestamptz,
  ADD COLUMN response_delivered_at timestamptz,
  ADD COLUMN response_delivery_failed_at timestamptz,
  ADD COLUMN response_delivery_error text,
  ADD COLUMN response_transport_message_id text;

CREATE OR REPLACE FUNCTION public.claim_staff_response_delivery(
  p_id uuid, p_user_id uuid, p_lease_seconds integer DEFAULT 120
) RETURNS TABLE (
  message_id uuid, claimed boolean, claim_token uuid, response_text text,
  delivery_status text, delivery_attempts integer
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.staff_messages; v_token uuid := gen_random_uuid();
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v FROM public.staff_messages WHERE id=p_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='28000'; END IF;
  IF v.processing_status <> 'completed' OR v.carson_response IS NULL OR btrim(v.carson_response)='' THEN
    RETURN QUERY SELECT v.id,false,NULL::uuid,v.carson_response,v.response_delivery_status,v.response_delivery_attempts; RETURN;
  END IF;
  IF v.response_delivery_status='delivered'
     OR (v.response_delivery_status='sending' AND v.response_delivery_lease_until > now()) THEN
    RETURN QUERY SELECT v.id,false,NULL::uuid,v.carson_response,v.response_delivery_status,v.response_delivery_attempts; RETURN;
  END IF;
  UPDATE public.staff_messages SET response_delivery_status='sending',
    response_delivery_attempts=response_delivery_attempts+1,
    response_delivery_token=v_token,response_delivery_claimed_at=now(),
    response_delivery_lease_until=now()+make_interval(secs=>p_lease_seconds),
    response_delivery_error=NULL,response_delivery_failed_at=NULL
  WHERE id=p_id RETURNING * INTO v;
  RETURN QUERY SELECT v.id,true,v_token,v.carson_response,v.response_delivery_status,v.response_delivery_attempts;
END $$;

CREATE OR REPLACE FUNCTION public.complete_staff_response_delivery(
  p_id uuid,p_user_id uuid,p_claim_token uuid,p_transport_message_id text,p_delivered_at timestamptz
) RETURNS public.staff_messages LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v public.staff_messages;
BEGIN
  UPDATE public.staff_messages SET response_delivery_status='delivered',
    response_transport_message_id=NULLIF(btrim(p_transport_message_id),''),
    response_delivered_at=p_delivered_at,response_delivery_token=NULL,
    response_delivery_lease_until=NULL,response_delivery_error=NULL
  WHERE id=p_id AND user_id=p_user_id AND response_delivery_status='sending'
    AND response_delivery_token=p_claim_token RETURNING * INTO v;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_delivery_claim' USING ERRCODE='40001'; END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.fail_staff_response_delivery(
  p_id uuid,p_user_id uuid,p_claim_token uuid,p_error text,p_failed_at timestamptz
) RETURNS public.staff_messages LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v public.staff_messages;
BEGIN
  UPDATE public.staff_messages SET response_delivery_status='failed',
    response_delivery_failed_at=p_failed_at,response_delivery_error=left(NULLIF(btrim(p_error),''),500),
    response_delivery_token=NULL,response_delivery_lease_until=NULL
  WHERE id=p_id AND user_id=p_user_id AND response_delivery_status='sending'
    AND response_delivery_token=p_claim_token RETURNING * INTO v;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_delivery_claim' USING ERRCODE='40001'; END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.complete_staff_message(
  p_id uuid,p_user_id uuid,p_classification text,p_carson_response text,
  p_next_action_owner text,p_user_facing_state text,p_owner_attention_required boolean,
  p_escalation_reason text,p_responded_at timestamptz
) RETURNS public.staff_messages LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v public.staff_messages;
BEGIN
  SELECT * INTO v FROM public.staff_messages WHERE id=p_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='28000'; END IF;
  IF v.processing_status='completed' THEN RETURN v; END IF;
  IF v.processing_status<>'claimed' THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE='22023'; END IF;
  UPDATE public.staff_messages SET classification=p_classification,carson_response=p_carson_response,
    next_action_owner=p_next_action_owner,user_facing_state=p_user_facing_state,
    owner_attention_required=p_owner_attention_required,escalation_reason=p_escalation_reason,
    responded_at=p_responded_at,processing_status='completed',
    response_delivery_status=CASE WHEN source='whatsapp' THEN 'pending' ELSE 'not_required' END
  WHERE id=p_id RETURNING * INTO v;
  RETURN v;
END $$;

REVOKE EXECUTE ON FUNCTION public.claim_staff_response_delivery(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_staff_response_delivery(uuid,uuid,uuid,text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_staff_response_delivery(uuid,uuid,uuid,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_staff_response_delivery(uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_staff_response_delivery(uuid,uuid,uuid,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_staff_response_delivery(uuid,uuid,uuid,text,timestamptz) TO service_role;
