/**
 * Rollback for 20260812_durable_person_id_communication_history.sql.
 *
 * Restores claim_escalation_owner_decision to its pre-migration body
 * (identical logic, minus person_id) and drops the two new columns
 * (which drops their indexes and FK constraints along with them).
 * Does not touch messages.person_id (pre-existing column, unchanged by
 * the forward migration's schema) or any task-deletion behavior.
 */

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

DROP INDEX IF EXISTS public.staff_escalation_owner_decisions_person_id_idx;
DROP INDEX IF EXISTS public.whatsapp_deliveries_person_id_idx;

ALTER TABLE public.staff_escalation_owner_decisions DROP COLUMN IF EXISTS person_id;
ALTER TABLE public.whatsapp_deliveries DROP COLUMN IF EXISTS person_id;
