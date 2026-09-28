-- Slice 1 — stalled tracked delegation → owner handoff: review_type 'no_response'
-- (owner-authorized 2026-09-27, "AUTHORIZED — SLICE 1 DECISIONS RESOLVED").
--
-- SCOPE (exactly two changes, nothing else):
--   1. staff_escalation_owner_decisions_review_type_check gains 'no_response'.
--   2. claim_task_escalation_owner_decision()'s internal allow-list gains
--      'no_response'.
--
-- 'no_response' is used ONLY for the task-only stalled-delegation owner
-- handoff: a tracked delegation was followed up, escalated, and the recipient
-- has still produced no reply and no verified completion. It is deliberately
-- NOT 'staff_escalation', which means a staff member raised something.
--
-- Unchanged: every column, index (incl. the task-only-open partial unique
-- index), RLS policy, every other CHECK, the four existing review types, every
-- existing row, and the RPC's SECURITY DEFINER, search_path, ownership check,
-- FOR UPDATE SKIP LOCKED, ON CONFLICT DO NOTHING and post-conflict re-select.
-- The RPC body below is the currently deployed definition
-- (20260927_claim_task_escalation_allow_staff_escalation.sql) with one token
-- added to the IN (...) list.
--
-- Every existing row already satisfies the widened CHECK, so re-adding it
-- validates cleanly (27 rows at authoring time).
--
-- Rollback: 20260928_escalation_review_type_no_response.rollback.sql.

ALTER TABLE public.staff_escalation_owner_decisions
  DROP CONSTRAINT staff_escalation_owner_decisions_review_type_check,
  ADD CONSTRAINT staff_escalation_owner_decisions_review_type_check
    CHECK (review_type = ANY (ARRAY['staff_escalation'::text, 'uncertain_proof'::text,
                                    'substitute_review'::text, 'correction_limit'::text,
                                    'no_response'::text]));

CREATE OR REPLACE FUNCTION public.claim_task_escalation_owner_decision(
  p_task_id uuid,
  p_user_id uuid,
  p_review_type text,
  p_person_id uuid DEFAULT NULL::uuid
)
RETURNS staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_row public.staff_escalation_owner_decisions;
BEGIN
  IF p_review_type NOT IN ('uncertain_proof', 'substitute_review', 'correction_limit', 'staff_escalation', 'no_response') THEN
    RAISE EXCEPTION 'invalid_review_type' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.tasks WHERE id = p_task_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row FROM public.staff_escalation_owner_decisions
    WHERE task_id = p_task_id
      AND staff_message_id IS NULL
      AND status NOT IN ('delivered_to_staff', 'failed')
    FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  INSERT INTO public.staff_escalation_owner_decisions (
    staff_message_id, user_id, task_id, review_type, person_id
  ) VALUES (
    NULL, p_user_id, p_task_id, p_review_type, p_person_id
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    SELECT * INTO v_row FROM public.staff_escalation_owner_decisions
      WHERE task_id = p_task_id
        AND staff_message_id IS NULL
        AND status NOT IN ('delivered_to_staff', 'failed');
  END IF;

  RETURN v_row;
END;
$function$;
