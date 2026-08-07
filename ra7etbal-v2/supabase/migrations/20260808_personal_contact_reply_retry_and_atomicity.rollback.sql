DROP FUNCTION IF EXISTS public.record_personal_contact_reply(uuid, uuid, text, text, text, text);

CREATE FUNCTION public.record_personal_contact_reply(
  p_user_id uuid,
  p_person_id uuid,
  p_sender_phone text,
  p_external_message_id text,
  p_inbound_text text,
  p_correlation_method text,
  p_correlated_delivery_id uuid
) RETURNS TABLE (
  row_id uuid,
  newly_recorded boolean,
  owner_notification_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inserted public.personal_contact_replies;
  v_existing public.personal_contact_replies;
BEGIN
  IF NULLIF(btrim(p_sender_phone), '') IS NULL
     OR NULLIF(btrim(p_external_message_id), '') IS NULL
     OR NULLIF(btrim(p_inbound_text), '') IS NULL
     OR p_correlation_method NOT IN ('quoted_context', 'single_recent', 'unmatched') THEN
    RAISE EXCEPTION 'missing_or_invalid_field' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.personal_contact_replies (
    user_id, person_id, sender_phone, external_message_id, inbound_text,
    correlation_method, correlated_delivery_id
  ) VALUES (
    p_user_id, p_person_id, btrim(p_sender_phone), btrim(p_external_message_id),
    p_inbound_text, p_correlation_method, p_correlated_delivery_id
  )
  ON CONFLICT (user_id, external_message_id) DO NOTHING
  RETURNING * INTO v_inserted;

  IF FOUND THEN
    RETURN QUERY SELECT v_inserted.id, true, v_inserted.owner_notification_status;
    RETURN;
  END IF;

  SELECT * INTO STRICT v_existing
  FROM public.personal_contact_replies
  WHERE user_id = p_user_id AND external_message_id = btrim(p_external_message_id);

  RETURN QUERY SELECT v_existing.id, false, v_existing.owner_notification_status;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_personal_contact_reply(uuid, uuid, text, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_personal_contact_reply(uuid, uuid, text, text, text, text, uuid)
  TO service_role;

ALTER TABLE public.personal_contact_replies
  DROP COLUMN IF EXISTS owner_notification_retry_count,
  DROP COLUMN IF EXISTS owner_notification_next_retry_at;
