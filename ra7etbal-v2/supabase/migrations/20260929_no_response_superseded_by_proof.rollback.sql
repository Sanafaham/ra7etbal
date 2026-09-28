-- ROLLBACK of 20260929_no_response_superseded_by_proof.sql (PROPOSAL ONLY).
-- Restores the pre-change CHECK, index and RPC exactly. Refuses to run while
-- any 'superseded' row exists: re-activating a superseded silence row could
-- collide with the proof review that replaced it. That is an owner decision.

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.staff_escalation_owner_decisions WHERE status = 'superseded') THEN
    RAISE EXCEPTION 'rollback_blocked: superseded rows exist; owner decision required';
  END IF;
END
$guard$;

DROP INDEX public.staff_escalation_owner_decisions_task_only_open_idx;
CREATE UNIQUE INDEX staff_escalation_owner_decisions_task_only_open_idx
  ON public.staff_escalation_owner_decisions USING btree (task_id)
  WHERE ((staff_message_id IS NULL)
     AND (status <> ALL (ARRAY['delivered_to_staff'::text, 'failed'::text])));

ALTER TABLE public.staff_escalation_owner_decisions
  DROP CONSTRAINT staff_escalation_owner_decisions_status_check,
  ADD CONSTRAINT staff_escalation_owner_decisions_status_check
    CHECK (status = ANY (ARRAY['open'::text, 'answered'::text, 'delivering'::text,
                               'delivered_to_staff'::text, 'failed'::text]));

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
