/**
 * Rollback for 20260712_approve_alternative_message_first.sql
 *
 * Restores reserve_custom_instruction / complete_custom_instruction /
 * reopen_substitute_decision_on_delivery_failure to their exact pre-fix
 * definitions and recreates complete_approved_alternative. Reverting this
 * brings back the premature-completion bug (Approve Alternative marks the
 * task done with no WhatsApp message) — only apply if this fix itself needs
 * to be undone.
 */

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
  IF NOT FOUND OR v_decision.decision <> 'custom_instruction' THEN RAISE EXCEPTION 'invalid_decision'; END IF;
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


CREATE OR REPLACE FUNCTION public.complete_custom_instruction(
  p_decision_id uuid, p_lease_token uuid, p_user_id uuid, p_delivery_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_decision quality_substitute_decisions; v_delivery whatsapp_deliveries; v_task tasks;
BEGIN
  SELECT * INTO v_decision FROM quality_substitute_decisions WHERE id = p_decision_id FOR UPDATE;
  IF NOT FOUND OR v_decision.decision <> 'custom_instruction' THEN RAISE EXCEPTION 'invalid_decision'; END IF;
  IF v_decision.status = 'completed' THEN RETURN; END IF;
  IF v_decision.lease_token <> p_lease_token THEN RAISE EXCEPTION 'lease_lost' USING ERRCODE = 'P0004'; END IF;
  IF v_decision.user_id <> p_user_id THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000'; END IF;
  IF v_decision.delivery_id IS DISTINCT FROM p_delivery_id THEN RAISE EXCEPTION 'delivery_mismatch'; END IF;

  SELECT * INTO v_delivery FROM whatsapp_deliveries
    WHERE id = p_delivery_id AND message_id = v_decision.message_id
      AND task_id = v_decision.task_id AND user_id = v_decision.user_id;
  IF NOT FOUND OR v_delivery.delivery_status <> 'accepted' THEN
    RAISE EXCEPTION 'delivery_not_accepted' USING ERRCODE = 'P0005';
  END IF;

  SELECT * INTO v_task FROM tasks WHERE id = v_decision.task_id FOR UPDATE;
  IF v_task.quality_reviewed_at IS DISTINCT FROM v_decision.reviewed_at THEN
    RAISE EXCEPTION 'stale_review' USING ERRCODE = 'P0001';
  END IF;

  UPDATE tasks SET
    quality_review_status = NULL, quality_review_note = NULL, quality_reviewed_at = NULL, worker_reply = NULL
  WHERE id = v_decision.task_id;

  UPDATE quality_substitute_decisions SET status = 'completed', completed_at = now(), outcome = 'custom_instruction_sent'
  WHERE id = p_decision_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.complete_approved_alternative(
  p_decision_id uuid, p_lease_token uuid, p_user_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_decision quality_substitute_decisions; v_task tasks;
BEGIN
  SELECT * INTO v_decision FROM quality_substitute_decisions WHERE id = p_decision_id FOR UPDATE;
  IF NOT FOUND OR v_decision.decision <> 'approved_alternative' THEN RAISE EXCEPTION 'invalid_decision'; END IF;
  IF v_decision.status = 'completed' THEN RETURN; END IF;
  IF v_decision.lease_token <> p_lease_token THEN RAISE EXCEPTION 'lease_lost' USING ERRCODE = 'P0004'; END IF;
  IF v_decision.user_id <> p_user_id THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000'; END IF;

  SELECT * INTO v_task FROM tasks WHERE id = v_decision.task_id FOR UPDATE;
  IF v_task.quality_reviewed_at IS DISTINCT FROM v_decision.reviewed_at THEN
    RAISE EXCEPTION 'stale_review' USING ERRCODE = 'P0001';
  END IF;

  UPDATE tasks SET
    quality_review_status = 'approved', status = 'done', confirmed_at = now(), needs_follow_up = false
  WHERE id = v_decision.task_id;

  UPDATE quality_substitute_decisions SET status = 'completed', completed_at = now(), outcome = 'approved'
  WHERE id = p_decision_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.reopen_substitute_decision_on_delivery_failure(
  p_delivery_id uuid
) RETURNS TABLE(task_id uuid, user_id uuid, description text, assigned_to text, reopened boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_decision quality_substitute_decisions;
  v_task tasks;
  v_expected_status text;
BEGIN
  SELECT * INTO v_decision FROM quality_substitute_decisions
    WHERE delivery_id = p_delivery_id
      AND status = 'completed'
      AND decision IN ('rejected_alternative', 'custom_instruction')
    LIMIT 1
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text, false;
    RETURN;
  END IF;

  v_expected_status := CASE WHEN v_decision.decision = 'rejected_alternative' THEN 'correction_required' ELSE NULL END;

  SELECT * INTO v_task FROM tasks WHERE id = v_decision.task_id FOR UPDATE;

  IF NOT FOUND
     OR v_task.status <> 'pending'
     OR v_task.quality_review_status IS DISTINCT FROM v_expected_status THEN
    RETURN QUERY SELECT v_decision.task_id, v_decision.user_id, NULL::text, NULL::text, false;
    RETURN;
  END IF;

  UPDATE tasks SET
    quality_review_status = 'substitute_review',
    quality_review_note = COALESCE(v_decision.qi_note, v_task.quality_review_note),
    quality_reviewed_at = now(),
    worker_reply = v_decision.worker_reply
  WHERE id = v_decision.task_id;

  UPDATE quality_substitute_decisions
  SET failure_reason = 'WhatsApp delivery failed asynchronously after this decision completed — task reopened for a new owner decision.'
  WHERE id = v_decision.id;

  RETURN QUERY SELECT v_decision.task_id, v_decision.user_id, v_task.description, v_task.assigned_to, true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_custom_instruction(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_approved_alternative(uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reopen_substitute_decision_on_delivery_failure(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_custom_instruction(uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_approved_alternative(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reopen_substitute_decision_on_delivery_failure(uuid) TO service_role;
