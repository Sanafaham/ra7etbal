/**
 * Durable person attribution for task-based owner-decision rows.
 *
 * PR #235 (20260812_durable_person_id_communication_history.sql) added
 * person_id to staff_escalation_owner_decisions and populated it at write
 * time for the WhatsApp-staff-message path (claim_escalation_owner_decision,
 * review_type='staff_escalation'). It deliberately left the task-based path
 * (claim_task_escalation_owner_decision, review_type in
 * 'uncertain_proof'/'substitute_review'/'correction_limit') unchanged,
 * because tasks has no person_id column to derive one from.
 *
 * A live production trace found this is a real, currently-open gap: the
 * exact row that motivated PR #235 ("Approve it", review_type=
 * substitute_review) has staff_message_id=NULL, task_id=NULL (after Clear
 * History), and person_id=NULL -- unreachable by Communication History,
 * and PR #235's write-time fix could never have protected it, because this
 * creation path never resolved a person identity in the first place.
 *
 * Fix: claim_task_escalation_owner_decision gains an optional p_person_id
 * parameter (default NULL, fully backward compatible -- existing callers
 * that don't pass it are unaffected). The application-layer change
 * (api/_escalation-notify.js) resolves this from tasks.assigned_to via an
 * exact, case-insensitive name match against people -- the same resolution
 * shape already trusted elsewhere in this codebase (task-confirm.js's
 * findAssigneePerson) for deciding who to message. Never fuzzy, never
 * guesses on ambiguity.
 *
 * No backfill in this migration. Traced exhaustively: no call path ever
 * resolved a person identity for existing task-based rows before this fix
 * -- there is no surviving immutable evidence (staff_message_id, a real
 * FK, or any other deterministic relationship) that uniquely identifies
 * the person for any existing NULL row on this creation path, including
 * the motivating "Approve it" row. Per the deterministic-only rule, these
 * rows are classified unrecoverable (category C) and are left NULL, not
 * guessed from the historical investigation's own knowledge of who they
 * concerned. This is an accepted, documented limitation of historical
 * data written before this fix -- new task-based rows going forward will
 * have person_id populated whenever an unambiguous match exists.
 *
 * Rollback: see 20260812_task_review_owner_decision_person_id.rollback.sql
 */

-- Postgres treats a function with an added parameter as a distinct
-- overload, not a replacement -- CREATE OR REPLACE alone would leave the
-- old 3-argument version callable alongside this one, which PostgREST
-- (the REST RPC layer every caller uses) cannot disambiguate. Drop the
-- old signature explicitly before creating the new one.
DROP FUNCTION IF EXISTS public.claim_task_escalation_owner_decision(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.claim_task_escalation_owner_decision(
  p_task_id    uuid,
  p_user_id    uuid,
  p_review_type text,
  p_person_id  uuid DEFAULT NULL
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
$$;

REVOKE EXECUTE ON FUNCTION public.claim_task_escalation_owner_decision(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_task_escalation_owner_decision(uuid, uuid, text, uuid) TO service_role;
