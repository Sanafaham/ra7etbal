/**
 * Minimal immutable evidence for inbound WhatsApp correlation investigations.
 * No message text and no full webhook payload are retained.
 */

CREATE TABLE IF NOT EXISTS public.whatsapp_inbound_evidence (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_meta_message_id       text NOT NULL,
  context_present               boolean NOT NULL,
  raw_context_id                jsonb NULL,
  raw_context_from              jsonb NULL,
  normalized_context_message_id text NULL,
  message_type                  text NOT NULL,
  sender_phone                  text NOT NULL,
  business_number_id            text NOT NULL,
  webhook_received_at           timestamptz NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_inbound_evidence_message_key
    UNIQUE (business_number_id, inbound_meta_message_id)
);

ALTER TABLE public.whatsapp_inbound_evidence ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.reject_whatsapp_inbound_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'whatsapp_inbound_evidence_is_immutable' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS reject_whatsapp_inbound_evidence_update
  ON public.whatsapp_inbound_evidence;
CREATE TRIGGER reject_whatsapp_inbound_evidence_update
BEFORE UPDATE OR DELETE ON public.whatsapp_inbound_evidence
FOR EACH ROW EXECUTE FUNCTION public.reject_whatsapp_inbound_evidence_mutation();

CREATE OR REPLACE FUNCTION public.record_whatsapp_inbound_evidence(
  p_inbound_meta_message_id text,
  p_context_present boolean,
  p_raw_context_id jsonb,
  p_raw_context_from jsonb,
  p_normalized_context_message_id text,
  p_message_type text,
  p_sender_phone text,
  p_business_number_id text,
  p_webhook_received_at timestamptz
) RETURNS public.whatsapp_inbound_evidence
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.whatsapp_inbound_evidence;
BEGIN
  IF NULLIF(btrim(p_inbound_meta_message_id), '') IS NULL
     OR NULLIF(btrim(p_message_type), '') IS NULL
     OR NULLIF(btrim(p_sender_phone), '') IS NULL
     OR NULLIF(btrim(p_business_number_id), '') IS NULL
     OR p_context_present IS NULL
     OR p_webhook_received_at IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.whatsapp_inbound_evidence (
    inbound_meta_message_id, context_present, raw_context_id, raw_context_from,
    normalized_context_message_id, message_type, sender_phone,
    business_number_id, webhook_received_at
  ) VALUES (
    btrim(p_inbound_meta_message_id), p_context_present, p_raw_context_id,
    p_raw_context_from,
    NULLIF(btrim(p_normalized_context_message_id), ''), btrim(p_message_type),
    btrim(p_sender_phone), btrim(p_business_number_id), p_webhook_received_at
  )
  ON CONFLICT (business_number_id, inbound_meta_message_id) DO NOTHING
  RETURNING * INTO v;

  IF NOT FOUND THEN
    SELECT * INTO STRICT v
    FROM public.whatsapp_inbound_evidence
    WHERE business_number_id = btrim(p_business_number_id)
      AND inbound_meta_message_id = btrim(p_inbound_meta_message_id);

    IF v.context_present IS DISTINCT FROM p_context_present
       OR v.raw_context_id IS DISTINCT FROM p_raw_context_id
       OR v.raw_context_from IS DISTINCT FROM p_raw_context_from
       OR v.normalized_context_message_id IS DISTINCT FROM NULLIF(btrim(p_normalized_context_message_id), '')
       OR v.message_type IS DISTINCT FROM btrim(p_message_type)
       OR v.sender_phone IS DISTINCT FROM btrim(p_sender_phone) THEN
      RAISE EXCEPTION 'inbound_evidence_conflict' USING ERRCODE = '23000';
    END IF;
  END IF;

  RETURN v;
END;
$$;

REVOKE ALL ON public.whatsapp_inbound_evidence FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_whatsapp_inbound_evidence(text, boolean, jsonb, jsonb, text, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_inbound_evidence(text, boolean, jsonb, jsonb, text, text, text, text, timestamptz)
  TO service_role;
