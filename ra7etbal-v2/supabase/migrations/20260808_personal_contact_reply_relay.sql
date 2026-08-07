/**
 * Personal Contact Reply Relay.
 *
 * Persists every inbound WhatsApp reply from a known family/personal
 * contact (people.is_family = true), independent of whether it could be
 * safely correlated to a prior outbound direct message. Ambiguous and
 * unmatched replies are never discarded — they are recorded here with
 * correlation_method = 'unmatched' and the owner is still notified, without
 * inventing a false correlation.
 *
 * Eligibility for the "single recent unresolved conversation" correlation
 * step is derived, in application code (api/_personal-contact-reply.js), from
 * the absence of a prior row in this table pointing at a given
 * whatsapp_deliveries.id — never from whatsapp_deliveries.delivery_status,
 * which reflects Meta transport state, not conversational reply state.
 */

CREATE TABLE IF NOT EXISTS public.personal_contact_replies (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL,
  person_id                uuid NULL REFERENCES public.people(id),
  sender_phone             text NOT NULL,
  external_message_id      text NOT NULL,
  inbound_text             text NOT NULL,
  correlation_method       text NOT NULL,
  correlated_delivery_id   uuid NULL REFERENCES public.whatsapp_deliveries(id),
  owner_notification_status text NOT NULL DEFAULT 'pending',
  owner_notification_text   text NULL,
  owner_notification_transport_message_id text NULL,
  owner_notified_at         timestamptz NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_contact_replies_message_key UNIQUE (user_id, external_message_id),
  CONSTRAINT personal_contact_replies_correlation_method_check
    CHECK (correlation_method IN ('quoted_context', 'single_recent', 'unmatched')),
  CONSTRAINT personal_contact_replies_owner_notification_status_check
    CHECK (owner_notification_status IN ('pending', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS personal_contact_replies_correlated_delivery_idx
  ON public.personal_contact_replies (correlated_delivery_id)
  WHERE correlated_delivery_id IS NOT NULL;

ALTER TABLE public.personal_contact_replies ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.record_personal_contact_reply(
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

  -- First-write-wins: a duplicate Meta webhook delivery for the same
  -- external_message_id never re-inserts and never re-notifies the owner.
  SELECT * INTO STRICT v_existing
  FROM public.personal_contact_replies
  WHERE user_id = p_user_id AND external_message_id = btrim(p_external_message_id);

  RETURN QUERY SELECT v_existing.id, false, v_existing.owner_notification_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_personal_contact_reply_notification(
  p_id uuid,
  p_user_id uuid,
  p_status text,
  p_notification_text text,
  p_transport_message_id text
) RETURNS public.personal_contact_replies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.personal_contact_replies;
BEGIN
  IF p_status NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.personal_contact_replies SET
    owner_notification_status = p_status,
    owner_notification_text = p_notification_text,
    owner_notification_transport_message_id = p_transport_message_id,
    owner_notified_at = CASE WHEN p_status = 'sent' THEN now() ELSE owner_notified_at END
  WHERE id = p_id AND user_id = p_user_id
  RETURNING * INTO v;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '28000';
  END IF;

  RETURN v;
END;
$$;

REVOKE ALL ON public.personal_contact_replies FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_personal_contact_reply(uuid, uuid, text, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_personal_contact_reply_notification(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_personal_contact_reply(uuid, uuid, text, text, text, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_personal_contact_reply_notification(uuid, uuid, text, text, text)
  TO service_role;
