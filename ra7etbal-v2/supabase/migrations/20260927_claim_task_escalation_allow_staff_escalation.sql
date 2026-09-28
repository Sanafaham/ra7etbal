-- Slice 1 — stalled tracked delegation → owner handoff (2026-09-27).
--
-- NARROW ALIGNMENT, NOT A SCHEMA CHANGE.
--
-- staff_escalation_owner_decisions_review_type_check ALREADY permits
-- 'staff_escalation':
--
--   CHECK (review_type = ANY (ARRAY['staff_escalation','uncertain_proof',
--                                   'substitute_review','correction_limit']))
--
-- but claim_task_escalation_owner_decision() carries its own internal
-- allow-list that is NARROWER than the table's, so the only creation path
-- rejects a value the authoritative constraint already accepts. That blocked
-- the one truthful representation of "tracked delegation escalated, recipient
-- has produced no response": 'uncertain_proof' (no proof exists),
-- 'substitute_review' (nothing was proposed) and 'correction_limit' (no
-- correction cycle occurred) are each factually false for this state.
--
-- This migration adds that one already-table-legal value to the RPC's
-- allow-list. Everything else is byte-for-byte the deployed definition:
-- SECURITY DEFINER, search_path, the ownership check, FOR UPDATE SKIP LOCKED,
-- ON CONFLICT DO NOTHING, the post-conflict re-select, and the three existing
-- review types are all unchanged. No table, column, CHECK constraint, index,
-- RLS policy or row is touched.
--
-- Rollback: apply the .rollback.sql counterpart, which restores the previous
-- three-value allow-list verbatim.
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
  IF p_review_type NOT IN ('uncertain_proof', 'substitute_review', 'correction_limit', 'staff_escalation') THEN
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
