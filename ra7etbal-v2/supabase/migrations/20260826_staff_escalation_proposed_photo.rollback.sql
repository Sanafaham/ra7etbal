/**
 * Rollback for 20260826_staff_escalation_proposed_photo.sql.
 *
 * Restores claim_escalation_owner_decision to its exact pre-migration
 * 3-arg signature and drops the additive proposed_photo_path column.
 * Nothing else touched — the table's other columns, indexes, RLS
 * policies, and every other function (claim_task_escalation_owner_decision,
 * answer_escalation_owner_decision, claim/complete/fail_escalation_answer_
 * delivery, claim/complete/fail_owner_escalation_notification) are
 * untouched by either the forward migration or this rollback.
 */

DROP FUNCTION IF EXISTS public.claim_escalation_owner_decision(uuid, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.claim_escalation_owner_decision(
  p_staff_message_id uuid,
  p_user_id           uuid,
  p_task_id           uuid
) RETURNS public.staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_msg public.staff_messages;
  v_row public.staff_escalation_owner_decisions;
BEGIN
  SELECT * INTO v_msg FROM public.staff_messages WHERE id = p_staff_message_id FOR UPDATE;
  IF NOT FOUND OR v_msg.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  IF p_task_id IS NOT NULL THEN
    PERFORM 1 FROM public.tasks WHERE id = p_task_id AND user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
    END IF;
  END IF;

  SELECT * INTO v_row FROM public.staff_escalation_owner_decisions
    WHERE staff_message_id = p_staff_message_id;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  INSERT INTO public.staff_escalation_owner_decisions (staff_message_id, user_id, task_id)
  VALUES (p_staff_message_id, p_user_id, p_task_id)
  ON CONFLICT (staff_message_id) DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    SELECT * INTO v_row FROM public.staff_escalation_owner_decisions
      WHERE staff_message_id = p_staff_message_id;
  END IF;

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_escalation_owner_decision(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_escalation_owner_decision(uuid, uuid, uuid) TO service_role;

ALTER TABLE public.staff_escalation_owner_decisions
  DROP COLUMN IF EXISTS proposed_photo_path;
