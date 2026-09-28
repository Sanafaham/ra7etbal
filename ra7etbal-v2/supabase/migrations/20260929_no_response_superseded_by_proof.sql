-- Owner-authorized 2026-09-28 ("AUTHORIZED — APPLY THE SUPERSEDED DATABASE
-- CORRECTION AND COMPLETE OPTION A"). Identity boundary: the task UUID only.
--
-- Option A: newer authoritative same-task proof supersedes an older
-- no_response silence handoff, without deleting or faking anything.
--
-- Why a schema change is unavoidable: the only statuses that leave
-- staff_escalation_owner_decisions_task_only_open_idx are 'delivered_to_staff'
-- and 'failed'. Both would be false for a silence handoff that newer proof
-- made obsolete (nothing was delivered; nothing failed). So a truthful
-- terminal status is needed, the partial unique index must treat it as
-- inactive, and the claim RPC must perform the supersession atomically.
--
-- Changes (exactly three):
--   1. status CHECK gains 'superseded'.
--   2. task_only_open unique index also excludes 'superseded'.
--   3. claim_task_escalation_owner_decision(): when a proof review type is
--      claimed, an active no_response row for the SAME task (same user) is
--      set to 'superseded' first; every "active row" filter excludes it.
-- Unchanged: columns, RLS, grants, SECURITY DEFINER, search_path, every other
-- RPC. answer_escalation_owner_decision already rejects any status other
-- than open/answered/delivering/delivered_to_staff (invalid_transition), and
-- claim_escalation_answer_delivery only claims answered/failed/expired
-- delivering, so a superseded row can never be answered or re-sent.
--
-- Rollback: 20260929_no_response_superseded_by_proof.rollback.sql.

ALTER TABLE public.staff_escalation_owner_decisions
  DROP CONSTRAINT staff_escalation_owner_decisions_status_check,
  ADD CONSTRAINT staff_escalation_owner_decisions_status_check
    CHECK (status = ANY (ARRAY['open'::text, 'answered'::text, 'delivering'::text,
                               'delivered_to_staff'::text, 'failed'::text, 'superseded'::text]));

DROP INDEX public.staff_escalation_owner_decisions_task_only_open_idx;
CREATE UNIQUE INDEX staff_escalation_owner_decisions_task_only_open_idx
  ON public.staff_escalation_owner_decisions USING btree (task_id)
  WHERE ((staff_message_id IS NULL)
     AND (status <> ALL (ARRAY['delivered_to_staff'::text, 'failed'::text, 'superseded'::text])));

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

  -- Newer authoritative same-task proof supersedes an older no_response
  -- silence handoff. Identity is the task_id itself (the proof was submitted
  -- through that task's own confirmation link). The silence row is kept as
  -- history; only its status changes, and it leaves the one-active-per-task
  -- index so the proof review can take its place in this same transaction.
  IF p_review_type IN ('uncertain_proof', 'substitute_review', 'correction_limit') THEN
    UPDATE public.staff_escalation_owner_decisions
       SET status = 'superseded', updated_at = now()
     WHERE task_id = p_task_id
       AND user_id = p_user_id
       AND staff_message_id IS NULL
       AND review_type = 'no_response'
       AND status IN ('open', 'answered', 'delivering');
  END IF;

  SELECT * INTO v_row FROM public.staff_escalation_owner_decisions
    WHERE task_id = p_task_id
      AND staff_message_id IS NULL
      AND status NOT IN ('delivered_to_staff', 'failed', 'superseded')
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
        AND status NOT IN ('delivered_to_staff', 'failed', 'superseded');
  END IF;

  RETURN v_row;
END;
$function$;
