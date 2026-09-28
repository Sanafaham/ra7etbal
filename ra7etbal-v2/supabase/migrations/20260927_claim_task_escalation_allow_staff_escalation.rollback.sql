-- ROLLBACK of 20260927_claim_task_escalation_allow_staff_escalation.sql
--
-- Restores claim_task_escalation_owner_decision()'s previous three-value
-- allow-list ('uncertain_proof', 'substitute_review', 'correction_limit').
-- Everything else in the function body is unchanged. No table, CHECK, index,
-- RLS policy or row is touched.
--
-- ORDER: if 20260928_escalation_review_type_no_response.sql is applied, roll
-- that back first — this file restores a definition without 'no_response'.
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
