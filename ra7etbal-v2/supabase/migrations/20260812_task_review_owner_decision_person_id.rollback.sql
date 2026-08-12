/**
 * Rollback for 20260812_task_review_owner_decision_person_id.sql.
 * Restores claim_task_escalation_owner_decision to its pre-migration
 * 3-argument signature and body. Does not touch person_id values already
 * written by the 4-argument version -- those rows keep their person_id;
 * this only reverts the function so future task-based rows stop being
 * asked for one.
 */

DROP FUNCTION IF EXISTS public.claim_task_escalation_owner_decision(uuid, uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.claim_task_escalation_owner_decision(
  p_task_id    uuid,
  p_user_id    uuid,
  p_review_type text
) RETURNS public.staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.staff_escalation_owner_decisions;
BEGIN
  IF p_review_type NOT IN ('uncertain_proof', 'substitute_review', 'correction_limit') THEN
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
    staff_message_id, user_id, task_id, review_type
  ) VALUES (
    NULL, p_user_id, p_task_id, p_review_type
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
$$;

REVOKE EXECUTE ON FUNCTION public.claim_task_escalation_owner_decision(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_task_escalation_owner_decision(uuid, uuid, text) TO service_role;
