/**
 * Phase 8.1 bug fix — Approve Alternative completed the task before the
 * worker was ever told about the owner's decision.
 *
 * Root cause (confirmed via live production rows on task 3dbe480a-c4a0-4680-
 * a5e0-921984a4c0ed / decision 96e00331-7498-4f8b-951e-df24214bcf01):
 * complete_approved_alternative() never reserved a message or a delivery —
 * message_id and delivery_id were NULL on every approved_alternative
 * decision row — and unconditionally set tasks.status='done',
 * confirmed_at=now(), needs_follow_up=false in the same statement that
 * marked the decision completed. The worker (Ghulam) was never notified,
 * yet the task was already treated as finished.
 *
 * Fix: approved_alternative now goes through the exact same message-first
 * pipeline custom_instruction already used correctly — claim (unchanged) →
 * reserve_custom_instruction (message + delivery row) → reserve_send_window
 * (pre-send lease fence, unchanged) → Meta send → complete_custom_instruction
 * (only after delivery_status='accepted'). Both decision types differ only
 * in message content and the recorded outcome; complete_custom_instruction
 * already did the right thing for the task-state transition (clear the
 * substitute-review fields, never touch status/confirmed_at) — approve now
 * gets that behavior for free instead of duplicating it.
 *
 * reserve_custom_instruction / complete_custom_instruction keep their
 * existing names (not renamed) to avoid touching the one existing
 * custom_instruction call site and to keep this fix's diff minimal — both
 * are now intentionally shared by two decision types, not misnamed. See
 * api/task-confirm.js's handleOwnerDecision for the caller-side change.
 *
 * complete_approved_alternative() is dropped: keeping it around unused would
 * leave the exact broken behavior reachable again by a future accidental
 * call. See the companion rollback file to restore it if ever needed.
 *
 * reopen_substitute_decision_on_delivery_failure() (2026-07-11) is widened
 * to also match approved_alternative — now that Approve sends a real
 * message, its async Meta delivery failure needs the same reopen-into-
 * Needs-You handling custom_instruction/rejected_alternative already have.
 * The expected post-completion quality_review_status for the reopen check
 * was already NULL for anything other than rejected_alternative (the CASE
 * expression's `else null` branch), so approved_alternative needs no change
 * there — only the initial decision-type filter is widened.
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
  -- Shared by custom_instruction and approved_alternative — both need a
  -- single WhatsApp message reserved and sent before any task transition.
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


CREATE OR REPLACE FUNCTION public.complete_custom_instruction(
  p_decision_id uuid, p_lease_token uuid, p_user_id uuid, p_delivery_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_decision quality_substitute_decisions; v_delivery whatsapp_deliveries; v_task tasks;
BEGIN
  SELECT * INTO v_decision FROM quality_substitute_decisions WHERE id = p_decision_id FOR UPDATE;
  -- Shared by custom_instruction and approved_alternative (see
  -- reserve_custom_instruction above) — the task-state transition is
  -- identical for both: clear the substitute-review fields, never touch
  -- status/confirmed_at. Only the recorded outcome differs.
  IF NOT FOUND OR v_decision.decision NOT IN ('custom_instruction', 'approved_alternative') THEN
    RAISE EXCEPTION 'invalid_decision';
  END IF;
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

  -- task.status and confirmed_at are never touched here — an owner decision
  -- is not task completion. The task stays pending/open until the worker
  -- completes it through the normal confirmation flow.
  UPDATE tasks SET
    quality_review_status = NULL, quality_review_note = NULL, quality_reviewed_at = NULL, worker_reply = NULL
  WHERE id = v_decision.task_id;

  UPDATE quality_substitute_decisions SET status = 'completed', completed_at = now(),
    outcome = CASE WHEN v_decision.decision = 'approved_alternative' THEN 'approved' ELSE 'custom_instruction_sent' END
  WHERE id = p_decision_id;
END;
$$;


-- complete_approved_alternative is no longer called — approved_alternative
-- now completes through complete_custom_instruction above. Dropped rather
-- than left unused so its premature-completion behavior can never be
-- reintroduced by an accidental call.
DROP FUNCTION IF EXISTS public.complete_approved_alternative(uuid, uuid, uuid);


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
      -- approved_alternative now sends a real message too (2026-07-12) and
      -- needs the same async-failure reopen coverage.
      AND decision IN ('rejected_alternative', 'custom_instruction', 'approved_alternative')
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
    -- Task moved on for an unrelated reason since this decision completed —
    -- never clobber newer state with a stale reopen.
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


-- ── Execute grants (unchanged — CREATE OR REPLACE preserves existing grants,
--    these are re-asserted defensively; complete_approved_alternative's
--    grants are dropped along with the function) ───────────────────────────

REVOKE EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_custom_instruction(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reopen_substitute_decision_on_delivery_failure(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_custom_instruction(uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reopen_substitute_decision_on_delivery_failure(uuid) TO service_role;
