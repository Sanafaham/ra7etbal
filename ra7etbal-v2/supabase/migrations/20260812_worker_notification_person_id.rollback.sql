/**
 * Rollback for 20260812_worker_notification_person_id.sql.
 * Restores the original 7-argument signatures (no person_id) exactly as
 * defined by 20260710_quality_substitute_review.sql /
 * 20260712_approve_alternative_message_first.sql. Any person_id values
 * already written by the 8-argument versions are left in place on existing
 * rows -- this only reverts the function signature/behavior, not data.
 */

DROP FUNCTION IF EXISTS public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.reserve_rejected_alternative(uuid, uuid, uuid, text, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.reserve_custom_instruction(
  p_decision_id uuid, p_lease_token uuid, p_user_id uuid,
  p_message_content text, p_confirmation_url text, p_recipient text, p_recipient_name text
) RETURNS TABLE(message_id uuid, delivery_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_decision quality_substitute_decisions; v_task tasks; v_prior_delivery whatsapp_deliveries;
  v_message_id uuid; v_delivery_id uuid;
BEGIN
  SELECT * INTO v_decision FROM quality_substitute_decisions WHERE id = p_decision_id FOR UPDATE;
  IF NOT FOUND OR v_decision.decision NOT IN ('custom_instruction', 'approved_alternative') THEN
    RAISE EXCEPTION 'invalid_decision';
  END IF;
  IF v_decision.status = 'completed' THEN
    RETURN QUERY SELECT v_decision.message_id, v_decision.delivery_id; RETURN;
  END IF;
  IF v_decision.lease_token <> p_lease_token THEN RAISE EXCEPTION 'lease_lost' USING ERRCODE = 'P0004'; END IF;
  IF v_decision.user_id <> p_user_id THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000'; END IF;

  SELECT * INTO v_task FROM tasks WHERE id = v_decision.task_id FOR UPDATE;
  IF v_task.user_id <> v_decision.user_id OR v_task.quality_reviewed_at IS DISTINCT FROM v_decision.reviewed_at THEN
    RAISE EXCEPTION 'stale_review' USING ERRCODE = 'P0001';
  END IF;

  IF v_decision.message_id IS NOT NULL THEN
    v_message_id := v_decision.message_id;
  ELSE
    INSERT INTO messages (user_id, task_id, recipient, recipient_name, content, confirmation_url, channel, status)
    VALUES (v_decision.user_id, v_decision.task_id, p_recipient, p_recipient_name, p_message_content, p_confirmation_url, 'WhatsApp', 'prepared')
    RETURNING id INTO v_message_id;
    UPDATE quality_substitute_decisions SET message_id = v_message_id
    WHERE id = p_decision_id AND lease_token = p_lease_token;
  END IF;

  IF v_decision.delivery_id IS NOT NULL THEN
    SELECT * INTO v_prior_delivery FROM whatsapp_deliveries WHERE id = v_decision.delivery_id;
    IF v_prior_delivery.delivery_status = 'accepted' THEN
      RETURN QUERY SELECT v_message_id, v_decision.delivery_id; RETURN;
    END IF;
  END IF;

  INSERT INTO whatsapp_deliveries
    (user_id, message_id, task_id, parent_delivery_id, source_type, message_kind, recipient_phone, recipient_name, delivery_status)
  VALUES (v_decision.user_id, v_message_id, v_decision.task_id, v_decision.delivery_id, 'message', 'template', p_recipient, p_recipient_name, 'pending')
  RETURNING id INTO v_delivery_id;

  UPDATE quality_substitute_decisions SET delivery_id = v_delivery_id
  WHERE id = p_decision_id AND lease_token = p_lease_token;

  RETURN QUERY SELECT v_message_id, v_delivery_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_rejected_alternative(
  p_decision_id uuid, p_lease_token uuid, p_user_id uuid,
  p_message_content text, p_confirmation_url text, p_recipient text, p_recipient_name text
) RETURNS TABLE(outcome text, message_id uuid, delivery_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_decision quality_substitute_decisions; v_task tasks; v_prior_delivery whatsapp_deliveries;
  v_new_count int; v_message_id uuid; v_delivery_id uuid;
BEGIN
  SELECT * INTO v_decision FROM quality_substitute_decisions WHERE id = p_decision_id FOR UPDATE;
  IF NOT FOUND OR v_decision.decision <> 'rejected_alternative' THEN RAISE EXCEPTION 'invalid_decision'; END IF;
  IF v_decision.status = 'completed' THEN
    RETURN QUERY SELECT v_decision.outcome, v_decision.message_id, v_decision.delivery_id; RETURN;
  END IF;
  IF v_decision.lease_token <> p_lease_token THEN RAISE EXCEPTION 'lease_lost' USING ERRCODE = 'P0004'; END IF;
  IF v_decision.user_id <> p_user_id THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000'; END IF;

  SELECT * INTO v_task FROM tasks WHERE id = v_decision.task_id FOR UPDATE;
  IF v_task.user_id <> v_decision.user_id OR v_task.quality_reviewed_at IS DISTINCT FROM v_decision.reviewed_at THEN
    RAISE EXCEPTION 'stale_review' USING ERRCODE = 'P0001';
  END IF;

  IF v_decision.outcome IS NULL THEN
    v_new_count := COALESCE(v_task.quality_review_cycle_count, 0) + 1;

    IF v_new_count >= 3 THEN
      UPDATE tasks SET
        quality_review_status = 'uncertain',
        quality_review_note = 'Multiple proof attempts still need owner review. Latest issue: ' || COALESCE(v_decision.qi_note, 'substitute item offered.'),
        quality_review_cycle_count = v_new_count
      WHERE id = v_decision.task_id;

      UPDATE quality_substitute_decisions
      SET status = 'completed', completed_at = now(), outcome = 'fallback_to_uncertain'
      WHERE id = p_decision_id AND lease_token = p_lease_token;

      RETURN QUERY SELECT 'fallback_to_uncertain'::text, NULL::uuid, NULL::uuid; RETURN;
    END IF;

    UPDATE quality_substitute_decisions
    SET outcome = 'correction_required', pending_cycle_count = v_new_count
    WHERE id = p_decision_id AND lease_token = p_lease_token;
    v_decision.outcome := 'correction_required';
  END IF;

  IF v_decision.outcome = 'fallback_to_uncertain' THEN
    RETURN QUERY SELECT 'fallback_to_uncertain'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  IF v_decision.message_id IS NOT NULL THEN
    v_message_id := v_decision.message_id;
  ELSE
    INSERT INTO messages (user_id, task_id, recipient, recipient_name, content, confirmation_url, channel, status)
    VALUES (v_decision.user_id, v_decision.task_id, p_recipient, p_recipient_name, p_message_content, p_confirmation_url, 'WhatsApp', 'prepared')
    RETURNING id INTO v_message_id;
    UPDATE quality_substitute_decisions SET message_id = v_message_id
    WHERE id = p_decision_id AND lease_token = p_lease_token;
  END IF;

  IF v_decision.delivery_id IS NOT NULL THEN
    SELECT * INTO v_prior_delivery FROM whatsapp_deliveries WHERE id = v_decision.delivery_id;
    IF v_prior_delivery.delivery_status = 'accepted' THEN
      RETURN QUERY SELECT 'correction_required'::text, v_message_id, v_decision.delivery_id; RETURN;
    END IF;
  END IF;

  INSERT INTO whatsapp_deliveries
    (user_id, message_id, task_id, parent_delivery_id, source_type, message_kind, recipient_phone, recipient_name, delivery_status)
  VALUES (v_decision.user_id, v_message_id, v_decision.task_id, v_decision.delivery_id, 'message', 'template', p_recipient, p_recipient_name, 'pending')
  RETURNING id INTO v_delivery_id;

  UPDATE quality_substitute_decisions SET delivery_id = v_delivery_id
  WHERE id = p_decision_id AND lease_token = p_lease_token;

  RETURN QUERY SELECT 'correction_required'::text, v_message_id, v_delivery_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reserve_rejected_alternative(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_rejected_alternative(uuid, uuid, uuid, text, text, text, text) TO service_role;
