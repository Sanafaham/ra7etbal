/**
 * Personal Contact Reply Relay — reliability follow-up (pre-merge review).
 *
 * 1. Owner notification retry: adds the same next_retry_at/retry_count sweep
 *    pattern already used by owner_whatsapp_reply_receipts (see
 *    markRetryable in api/_owner-command-executor.js and
 *    reconcileOwnerWhatsappMessages in api/_owner-whatsapp-routing.js) —
 *    reused, not reinvented. A failed owner-relay send is retried by the
 *    same already-scheduled QStash cron sweep in
 *    api/process-delegation-escalations.js, not a new mechanism.
 *
 * 2. Correlation atomicity: moves the "single eligible recent conversation"
 *    decision into record_personal_contact_reply itself, serialized per
 *    (user_id, sender_phone) with pg_advisory_xact_lock so two concurrent
 *    replies from the same person can never both claim the same delivery.
 *    Safe because the function was never called in production (PR #196 has
 *    not merged) — no live callers depend on the prior signature.
 */

ALTER TABLE public.personal_contact_replies
  ADD COLUMN IF NOT EXISTS owner_notification_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS owner_notification_next_retry_at timestamptz NULL;

DROP FUNCTION IF EXISTS public.record_personal_contact_reply(uuid, uuid, text, text, text, text, uuid);

CREATE FUNCTION public.record_personal_contact_reply(
  p_user_id uuid,
  p_person_id uuid,
  p_sender_phone text,
  p_external_message_id text,
  p_inbound_text text,
  p_context_message_id text
) RETURNS TABLE (
  row_id uuid,
  newly_recorded boolean,
  owner_notification_status text,
  correlation_method text,
  correlated_delivery_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inserted public.personal_contact_replies;
  v_existing public.personal_contact_replies;
  v_delivery_id uuid;
  v_method text;
  v_candidate_count int;
  v_sender_phone text := btrim(p_sender_phone);
  v_since timestamptz := now() - interval '7 days';
BEGIN
  IF NULLIF(v_sender_phone, '') IS NULL
     OR NULLIF(btrim(p_external_message_id), '') IS NULL
     OR NULLIF(btrim(p_inbound_text), '') IS NULL THEN
    RAISE EXCEPTION 'missing_or_invalid_field' USING ERRCODE = '22023';
  END IF;

  -- Idempotency short-circuit first, cheap, and avoids doing correlation
  -- work at all on a duplicate webhook redelivery.
  SELECT * INTO v_existing
  FROM public.personal_contact_replies
  WHERE user_id = p_user_id AND external_message_id = btrim(p_external_message_id);
  IF FOUND THEN
    RETURN QUERY SELECT v_existing.id, false, v_existing.owner_notification_status,
      v_existing.correlation_method, v_existing.correlated_delivery_id;
    RETURN;
  END IF;

  -- Serialize correlation + claim per (user, sender phone) so two replies
  -- arriving concurrently for the same person can never both see the same
  -- "single eligible" delivery as available. Auto-released at transaction end.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_sender_phone, 0));

  IF p_context_message_id IS NOT NULL AND btrim(p_context_message_id) <> '' THEN
    SELECT id INTO v_delivery_id
    FROM public.whatsapp_deliveries
    WHERE user_id = p_user_id
      AND meta_message_id = btrim(p_context_message_id)
      AND recipient_phone = v_sender_phone
      AND metadata->>'direct_message' = 'true'
    LIMIT 1;
    IF FOUND THEN v_method := 'quoted_context'; END IF;
  END IF;

  IF v_delivery_id IS NULL THEN
    SELECT count(*) INTO v_candidate_count
    FROM public.whatsapp_deliveries wd
    WHERE wd.user_id = p_user_id
      AND wd.recipient_phone = v_sender_phone
      AND wd.metadata->>'direct_message' = 'true'
      AND wd.created_at >= v_since
      AND NOT EXISTS (
        SELECT 1 FROM public.personal_contact_replies pcr
        WHERE pcr.correlated_delivery_id = wd.id
      );
    IF v_candidate_count = 1 THEN
      SELECT wd.id INTO v_delivery_id
      FROM public.whatsapp_deliveries wd
      WHERE wd.user_id = p_user_id
        AND wd.recipient_phone = v_sender_phone
        AND wd.metadata->>'direct_message' = 'true'
        AND wd.created_at >= v_since
        AND NOT EXISTS (
          SELECT 1 FROM public.personal_contact_replies pcr
          WHERE pcr.correlated_delivery_id = wd.id
        )
      LIMIT 1;
      v_method := 'single_recent';
    END IF;
  END IF;

  IF v_delivery_id IS NULL THEN
    v_method := 'unmatched';
  END IF;

  INSERT INTO public.personal_contact_replies (
    user_id, person_id, sender_phone, external_message_id, inbound_text,
    correlation_method, correlated_delivery_id
  ) VALUES (
    p_user_id, p_person_id, v_sender_phone, btrim(p_external_message_id),
    p_inbound_text, v_method, v_delivery_id
  )
  ON CONFLICT (user_id, external_message_id) DO NOTHING
  RETURNING * INTO v_inserted;

  IF FOUND THEN
    RETURN QUERY SELECT v_inserted.id, true, v_inserted.owner_notification_status,
      v_inserted.correlation_method, v_inserted.correlated_delivery_id;
    RETURN;
  END IF;

  -- Lost a race on external_message_id itself (true duplicate webhook,
  -- concurrent delivery of the same event) — first-write-wins, unchanged.
  SELECT * INTO STRICT v_existing
  FROM public.personal_contact_replies
  WHERE user_id = p_user_id AND external_message_id = btrim(p_external_message_id);

  RETURN QUERY SELECT v_existing.id, false, v_existing.owner_notification_status,
    v_existing.correlation_method, v_existing.correlated_delivery_id;
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
    owner_notified_at = CASE WHEN p_status = 'sent' THEN now() ELSE owner_notified_at END,
    -- Same 60-second backoff already used by markRetryable in
    -- _owner-command-executor.js. retry_count is the terminal signal (no new
    -- 'terminal_failed' status needed) — the reconciliation sweep excludes
    -- rows at MAX_RETRIES, matching _owner-command-executor.js's exhaustion
    -- bound (5).
    owner_notification_retry_count = CASE WHEN p_status = 'failed'
      THEN owner_notification_retry_count + 1 ELSE owner_notification_retry_count END,
    owner_notification_next_retry_at = CASE WHEN p_status = 'failed'
      THEN now() + interval '60 seconds' ELSE NULL END
  WHERE id = p_id AND user_id = p_user_id
  RETURNING * INTO v;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '28000';
  END IF;

  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_personal_contact_reply(uuid, uuid, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_personal_contact_reply(uuid, uuid, text, text, text, text)
  TO service_role;
