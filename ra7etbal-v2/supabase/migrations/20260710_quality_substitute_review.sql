/**
 * Phase 8.1 — Worker Reply + Substitute Review
 *
 * Adds a narrow third QI outcome (`substitute_review`) alongside the frozen
 * `approved` / `correction_required` / `uncertain` / `fraud_suspected`
 * outcomes, plus the owner-decision infrastructure for it: Approve
 * Alternative, Reject Alternative, Custom Instruction.
 *
 * Concurrency model: every owner decision is claimed via
 * claim_substitute_decision(), which mints a lease_token. Every subsequent
 * mutation (message/delivery reservation, the pre-send checkpoint, and
 * completion) revalidates that exact lease_token inside a locked
 * transaction, so a caller whose lease has been reclaimed by a stale-timeout
 * retry can never send WhatsApp or transition the task. See
 * reserve_send_window() for the mandatory checkpoint immediately before the
 * irreversible Meta API call.
 *
 * The correction-attempt ceiling (MAX_AUTOMATED_CORRECTION_ATTEMPTS = 3,
 * mirrored from api/task-confirm.js) is resolved once, atomically, inside
 * reserve_rejected_alternative() — before any WhatsApp send — exactly as it
 * is for the existing automated correction flow.
 *
 * Rollback: see the companion file
 * 20260710_quality_substitute_review.rollback.sql
 */

-- ── tasks: new optional worker-reply field ──────────────────────────────────

ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS worker_reply text;

-- ── tasks: widen the QI outcome CHECK constraint ────────────────────────────
-- Prior definition (recorded before this migration):
--   CHECK ((quality_review_status = ANY (ARRAY['approved'::text,
--     'correction_required'::text, 'uncertain'::text, 'fraud_suspected'::text])))

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_quality_review_status_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_quality_review_status_check
  CHECK (quality_review_status = ANY (ARRAY[
    'approved'::text,
    'correction_required'::text,
    'uncertain'::text,
    'fraud_suspected'::text,
    'substitute_review'::text
  ]));


-- ── quality_substitute_decisions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.quality_substitute_decisions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id                 uuid        NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  user_id                 uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  decision                text        NOT NULL
                                      CHECK (decision IN (
                                        'approved_alternative',
                                        'rejected_alternative',
                                        'custom_instruction'
                                      )),

  status                  text        NOT NULL DEFAULT 'processing'
                                      CHECK (status IN ('processing', 'completed')),

  -- Resolved once (at reserve time for rejected_alternative's correction-limit
  -- branch, at completion time for the other two) and never changed after.
  outcome                 text        NULL
                                      CHECK (outcome IS NULL OR outcome IN (
                                        'approved',
                                        'correction_required',
                                        'fallback_to_uncertain',
                                        'custom_instruction_sent'
                                      )),

  -- rejected_alternative only: the cycle-count value reserved at claim/reserve
  -- time, applied to tasks.quality_review_cycle_count only at completion.
  pending_cycle_count     int         NULL,

  qi_note                 text        NULL,
  worker_reply            text        NULL,
  requested_instruction   text        NULL, -- custom_instruction only; immutable snapshot for conflict detection

  reviewed_at             timestamptz NOT NULL, -- snapshot of tasks.quality_reviewed_at for this cycle

  message_id              uuid        NULL REFERENCES public.messages(id) ON DELETE SET NULL,
  delivery_id             uuid        NULL REFERENCES public.whatsapp_deliveries(id) ON DELETE SET NULL,

  failure_reason          text        NULL, -- non-WhatsApp failures only (WhatsApp failure detail lives on whatsapp_deliveries)

  lease_token             uuid        NOT NULL DEFAULT gen_random_uuid(),
  processing_started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz NULL,

  UNIQUE (task_id, reviewed_at)
);

CREATE INDEX IF NOT EXISTS quality_substitute_decisions_task_id_idx
  ON public.quality_substitute_decisions (task_id);

CREATE INDEX IF NOT EXISTS quality_substitute_decisions_user_id_idx
  ON public.quality_substitute_decisions (user_id);


-- ── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE public.quality_substitute_decisions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'quality_substitute_decisions'
      AND policyname = 'quality_substitute_decisions: owner can select'
  ) THEN
    CREATE POLICY "quality_substitute_decisions: owner can select"
      ON public.quality_substitute_decisions
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END
$$;

-- No INSERT/UPDATE/DELETE policy for authenticated/anon — all writes happen
-- exclusively through the SECURITY DEFINER functions below, callable only by
-- service_role.

GRANT SELECT ON public.quality_substitute_decisions TO authenticated;


-- ── Functions ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_substitute_decision(
  p_task_id uuid, p_user_id uuid, p_decision text, p_reviewed_at timestamptz DEFAULT NULL,
  p_qi_note text DEFAULT NULL, p_worker_reply text DEFAULT NULL, p_requested_instruction text DEFAULT NULL
) RETURNS public.quality_substitute_decisions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task tasks; v_existing quality_substitute_decisions; v_row quality_substitute_decisions;
  v_stale_before timestamptz := now() - interval '90 seconds';
  v_new_lease uuid := gen_random_uuid();
  v_reviewed_at timestamptz;
BEGIN
  SELECT * INTO v_task FROM tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR v_task.user_id <> p_user_id THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  v_reviewed_at := COALESCE(p_reviewed_at, v_task.quality_reviewed_at);

  -- Look for an existing decision BEFORE requiring live task state — a
  -- completed decision legitimately means the task has already moved on.
  SELECT * INTO v_existing FROM quality_substitute_decisions
    WHERE task_id = p_task_id AND reviewed_at = v_reviewed_at;

  IF FOUND THEN
    IF v_existing.decision <> p_decision
       OR (p_decision = 'custom_instruction'
           AND COALESCE(v_existing.requested_instruction, '') <> COALESCE(p_requested_instruction, '')) THEN
      RAISE EXCEPTION 'decision_conflict' USING ERRCODE = 'P0002';
    END IF;

    IF v_existing.status = 'completed' THEN
      RETURN v_existing; -- idempotent, regardless of current task state
    END IF;

    IF v_task.quality_review_status <> 'substitute_review' OR v_task.quality_reviewed_at <> v_reviewed_at THEN
      RAISE EXCEPTION 'stale_review' USING ERRCODE = 'P0001';
    END IF;
    IF v_existing.processing_started_at > v_stale_before THEN
      RAISE EXCEPTION 'still_processing' USING ERRCODE = 'P0003';
    END IF;

    UPDATE quality_substitute_decisions
    SET processing_started_at = now(), lease_token = v_new_lease
    WHERE id = v_existing.id AND status = 'processing' AND processing_started_at = v_existing.processing_started_at
    RETURNING * INTO v_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'still_processing' USING ERRCODE = 'P0003'; END IF;
    RETURN v_row;
  END IF;

  -- No decision exists for this cycle. A caller-supplied reviewed_at that
  -- doesn't match the live task is a stale view — never silently claim
  -- whatever cycle the task is currently in instead.
  IF p_reviewed_at IS NOT NULL AND p_reviewed_at <> v_task.quality_reviewed_at THEN
    RAISE EXCEPTION 'stale_review' USING ERRCODE = 'P0001';
  END IF;
  IF v_task.quality_review_status <> 'substitute_review' THEN
    RAISE EXCEPTION 'stale_review' USING ERRCODE = 'P0001';
  END IF;
  v_reviewed_at := v_task.quality_reviewed_at; -- server-trusted, never client-supplied

  INSERT INTO quality_substitute_decisions
    (task_id, user_id, decision, status, qi_note, worker_reply, reviewed_at, requested_instruction,
     processing_started_at, lease_token)
  VALUES
    (p_task_id, p_user_id, p_decision, 'processing', p_qi_note, p_worker_reply, v_reviewed_at, p_requested_instruction,
     now(), v_new_lease)
  ON CONFLICT (task_id, reviewed_at) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN RETURN v_row; END IF;

  SELECT * INTO v_existing FROM quality_substitute_decisions
    WHERE task_id = p_task_id AND reviewed_at = v_reviewed_at;
  IF v_existing.decision <> p_decision
     OR (p_decision = 'custom_instruction'
         AND COALESCE(v_existing.requested_instruction, '') <> COALESCE(p_requested_instruction, '')) THEN
    RAISE EXCEPTION 'decision_conflict' USING ERRCODE = 'P0002';
  END IF;
  IF v_existing.status = 'completed' THEN RETURN v_existing; END IF;
  RAISE EXCEPTION 'still_processing' USING ERRCODE = 'P0003';
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
    v_new_count := COALESCE(v_task.quality_review_cycle_count, 0) + 1; -- MAX_AUTOMATED_CORRECTION_ATTEMPTS = 3

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


CREATE OR REPLACE FUNCTION public.reserve_send_window(
  p_decision_id uuid, p_lease_token uuid, p_user_id uuid, p_delivery_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_decision quality_substitute_decisions; v_delivery whatsapp_deliveries;
BEGIN
  SELECT * INTO v_decision FROM quality_substitute_decisions WHERE id = p_decision_id FOR UPDATE;
  IF NOT FOUND OR v_decision.status <> 'processing' THEN RAISE EXCEPTION 'lease_lost' USING ERRCODE = 'P0004'; END IF;
  IF v_decision.lease_token <> p_lease_token THEN RAISE EXCEPTION 'lease_lost' USING ERRCODE = 'P0004'; END IF;
  IF v_decision.user_id <> p_user_id THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000'; END IF;
  IF v_decision.delivery_id IS DISTINCT FROM p_delivery_id THEN RAISE EXCEPTION 'delivery_superseded' USING ERRCODE = 'P0006'; END IF;

  SELECT * INTO v_delivery FROM whatsapp_deliveries
    WHERE id = p_delivery_id AND message_id = v_decision.message_id
      AND task_id = v_decision.task_id AND user_id = v_decision.user_id;
  IF NOT FOUND OR v_delivery.delivery_status <> 'pending' THEN
    RAISE EXCEPTION 'delivery_not_pending' USING ERRCODE = 'P0007';
  END IF;

  -- Renews the lease inside the same locked transaction that validated it —
  -- a stale-reclaim CAS targeting the pre-renewal processing_started_at can
  -- no longer match once this commits.
  UPDATE quality_substitute_decisions SET processing_started_at = now()
  WHERE id = p_decision_id AND lease_token = p_lease_token;
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


CREATE OR REPLACE FUNCTION public.complete_rejected_alternative(
  p_decision_id uuid, p_lease_token uuid, p_user_id uuid, p_delivery_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_decision quality_substitute_decisions; v_delivery whatsapp_deliveries; v_task tasks;
BEGIN
  SELECT * INTO v_decision FROM quality_substitute_decisions WHERE id = p_decision_id FOR UPDATE;
  IF NOT FOUND OR v_decision.decision <> 'rejected_alternative' THEN RAISE EXCEPTION 'invalid_decision'; END IF;
  IF v_decision.status = 'completed' THEN RETURN; END IF;
  IF v_decision.outcome <> 'correction_required' THEN RAISE EXCEPTION 'wrong_outcome_path'; END IF;
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
    quality_review_status = 'correction_required',
    quality_review_note = (SELECT content FROM messages WHERE id = v_decision.message_id),
    quality_review_cycle_count = v_decision.pending_cycle_count
  WHERE id = v_decision.task_id;

  UPDATE quality_substitute_decisions SET status = 'completed', completed_at = now()
  WHERE id = p_decision_id;
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


-- ── Execute grants: service_role only ───────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.claim_substitute_decision(uuid, uuid, text, timestamptz, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reserve_rejected_alternative(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reserve_send_window(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_approved_alternative(uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_rejected_alternative(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_custom_instruction(uuid, uuid, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.claim_substitute_decision(uuid, uuid, text, timestamptz, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_rejected_alternative(uuid, uuid, uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_send_window(uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_approved_alternative(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_rejected_alternative(uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_custom_instruction(uuid, uuid, uuid, uuid) TO service_role;
