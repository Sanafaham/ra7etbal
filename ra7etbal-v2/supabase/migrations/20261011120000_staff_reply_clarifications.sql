/**
 * P3 staff-reply clarification (blocked delegation journey, 2026-10-11).
 *
 * A plain-text staff reply that is about a task ("Salmon is unavailable")
 * but carries no exact task evidence (no WhatsApp quote-reply) is never
 * linked to a task by recency. Instead Carson asks the staff member which
 * of their pending tasks it is about, and links the ORIGINAL staff message
 * only when they answer with a listed number.
 *
 * The owner escalation for that original message is unchanged and fires
 * immediately through the existing claim/lease path. Resolving a
 * clarification never escalates, never completes a task and never changes
 * tasks.status. It only fills a still-blank staff_messages.task_id (and a
 * still-blank staff_escalation_owner_decisions.task_id for that same
 * message) once the answer has been validated here.
 *
 * Additive only:
 *   - one new table, public.staff_reply_clarifications
 *   - two SECURITY DEFINER functions, service_role only:
 *       open_staff_reply_clarification
 *       resolve_staff_reply_clarification
 * No existing table, column, constraint, policy or function is altered.
 * Rollback: 20261011120000_staff_reply_clarifications.rollback.sql.
 */

CREATE TABLE IF NOT EXISTS public.staff_reply_clarifications (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  person_id                uuid        NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  -- One clarification per incident (the original staff message). The
  -- UNIQUE constraint is what makes opening replay-safe.
  staff_message_id         uuid        NOT NULL UNIQUE REFERENCES public.staff_messages(id) ON DELETE CASCADE,
  candidate_task_ids       uuid[]      NOT NULL
    CHECK (cardinality(candidate_task_ids) BETWEEN 1 AND 9),
  question_text            text        NOT NULL CHECK (btrim(question_text) <> ''),
  status                   text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'linked', 'unrelated')),
  deadline_at              timestamptz NOT NULL,
  resolved_task_id         uuid        NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  answer_staff_message_id  uuid        NULL REFERENCES public.staff_messages(id) ON DELETE SET NULL,
  resolved_at              timestamptz NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'open') = (resolved_at IS NULL)),
  CHECK (status <> 'linked' OR resolved_task_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS staff_reply_clarifications_open_person_idx
  ON public.staff_reply_clarifications (user_id, person_id, created_at DESC)
  WHERE status = 'open';

-- Server-only, like staff_messages' write path: RLS on, no policies, and
-- no table privileges for anon/authenticated. service_role bypasses RLS.
ALTER TABLE public.staff_reply_clarifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_reply_clarifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.staff_reply_clarifications TO service_role;

-- ── open ────────────────────────────────────────────────────────────────
-- Idempotent: a second call for the same staff message (webhook replay)
-- returns the existing row, with its original question and candidates,
-- and never creates a second clarification.
CREATE OR REPLACE FUNCTION public.open_staff_reply_clarification(
  p_staff_message_id   uuid,
  p_user_id            uuid,
  p_candidate_task_ids uuid[],
  p_question_text      text,
  p_deadline_seconds   integer DEFAULT 1800
) RETURNS TABLE (
  clarification_id   uuid,
  is_new             boolean,
  status             text,
  candidate_task_ids uuid[],
  question_text      text,
  deadline_at        timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_msg       public.staff_messages%ROWTYPE;
  v_person    public.people%ROWTYPE;
  v_existing  public.staff_reply_clarifications%ROWTYPE;
  v_task      record;
  v_count     integer;
BEGIN
  IF p_staff_message_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'missing_arguments' USING ERRCODE = '22023';
  END IF;
  IF p_deadline_seconds IS NULL OR p_deadline_seconds < 60 OR p_deadline_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid_deadline' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_msg FROM public.staff_messages WHERE id = p_staff_message_id FOR UPDATE;
  IF NOT FOUND OR v_msg.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_existing FROM public.staff_reply_clarifications c
    WHERE c.staff_message_id = p_staff_message_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing.id, false, v_existing.status, v_existing.candidate_task_ids,
                        v_existing.question_text, v_existing.deadline_at;
    RETURN;
  END IF;

  -- Only an unlinked, completed staff message can be clarified.
  IF v_msg.task_id IS NOT NULL THEN
    RAISE EXCEPTION 'already_linked' USING ERRCODE = '22023';
  END IF;
  IF v_msg.processing_status <> 'completed' THEN
    RAISE EXCEPTION 'message_not_completed' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_person FROM public.people WHERE id = v_msg.person_id;
  IF NOT FOUND OR v_person.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;
  IF v_person.is_family IS TRUE THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '22023';
  END IF;

  IF p_question_text IS NULL OR btrim(p_question_text) = '' THEN
    RAISE EXCEPTION 'empty_question' USING ERRCODE = '22023';
  END IF;
  v_count := COALESCE(cardinality(p_candidate_task_ids), 0);
  IF v_count < 1 OR v_count > 9 THEN
    RAISE EXCEPTION 'invalid_candidates' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT t) FROM unnest(p_candidate_task_ids) AS t) <> v_count
     OR array_position(p_candidate_task_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_candidates' USING ERRCODE = '22023';
  END IF;

  -- Every candidate must be this owner's pending task, assigned to this
  -- staff member (same name rule as the webhook's loadValidatedStaffTask).
  FOR v_task IN
    SELECT t.id, t.user_id, t.status, t.assigned_to
      FROM unnest(p_candidate_task_ids) AS c(id)
      LEFT JOIN public.tasks t ON t.id = c.id
  LOOP
    IF v_task.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
    END IF;
    IF v_task.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'candidate_not_pending' USING ERRCODE = '22023';
    END IF;
    IF lower(btrim(COALESCE(v_task.assigned_to, ''))) <> lower(btrim(v_person.name)) THEN
      RAISE EXCEPTION 'candidate_not_assigned' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  INSERT INTO public.staff_reply_clarifications
    (user_id, person_id, staff_message_id, candidate_task_ids, question_text, deadline_at)
  VALUES
    (p_user_id, v_person.id, p_staff_message_id, p_candidate_task_ids, btrim(p_question_text),
     now() + make_interval(secs => p_deadline_seconds))
  RETURNING * INTO v_existing;

  RETURN QUERY SELECT v_existing.id, true, v_existing.status, v_existing.candidate_task_ids,
                      v_existing.question_text, v_existing.deadline_at;
END;
$$;

-- ── resolve ─────────────────────────────────────────────────────────────
-- p_choice: 0 = "something else" (closes as unrelated, links nothing);
-- 1..n = the candidate at that position. Bare-number answers are accepted
-- only before deadline_at. The row is locked, so concurrent answers have
-- exactly one winner; a repeat of the winning answer reports
-- already_resolved with the same outcome, a different answer is refused.
-- Never escalates, never completes a task, never touches tasks.
CREATE OR REPLACE FUNCTION public.resolve_staff_reply_clarification(
  p_clarification_id        uuid,
  p_user_id                 uuid,
  p_person_id               uuid,
  p_choice                  integer,
  p_answer_staff_message_id uuid
) RETURNS TABLE (
  outcome          text,
  status           text,
  staff_message_id uuid,
  resolved_task_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_c       public.staff_reply_clarifications%ROWTYPE;
  v_person  public.people%ROWTYPE;
  v_answer  public.staff_messages%ROWTYPE;
  v_task    public.tasks%ROWTYPE;
  v_task_id uuid;
  v_status  text;
BEGIN
  SELECT * INTO v_c FROM public.staff_reply_clarifications
    WHERE id = p_clarification_id FOR UPDATE;
  IF NOT FOUND OR v_c.user_id IS DISTINCT FROM p_user_id OR v_c.person_id IS DISTINCT FROM p_person_id THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  IF p_answer_staff_message_id IS NOT NULL THEN
    SELECT * INTO v_answer FROM public.staff_messages WHERE id = p_answer_staff_message_id;
    IF NOT FOUND OR v_answer.user_id IS DISTINCT FROM p_user_id
       OR v_answer.person_id IS DISTINCT FROM p_person_id THEN
      RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
    END IF;
  END IF;

  IF p_choice IS NULL OR p_choice < 0 OR p_choice > cardinality(v_c.candidate_task_ids) THEN
    RETURN QUERY SELECT 'invalid_choice'::text, v_c.status, v_c.staff_message_id, v_c.resolved_task_id;
    RETURN;
  END IF;

  v_task_id := CASE WHEN p_choice = 0 THEN NULL ELSE v_c.candidate_task_ids[p_choice] END;
  v_status  := CASE WHEN p_choice = 0 THEN 'unrelated' ELSE 'linked' END;

  IF v_c.status <> 'open' THEN
    IF v_c.status = v_status AND v_c.resolved_task_id IS NOT DISTINCT FROM v_task_id THEN
      RETURN QUERY SELECT 'already_resolved'::text, v_c.status, v_c.staff_message_id, v_c.resolved_task_id;
    ELSE
      RETURN QUERY SELECT 'conflict'::text, v_c.status, v_c.staff_message_id, v_c.resolved_task_id;
    END IF;
    RETURN;
  END IF;

  IF now() > v_c.deadline_at THEN
    RETURN QUERY SELECT 'expired'::text, v_c.status, v_c.staff_message_id, v_c.resolved_task_id;
    RETURN;
  END IF;

  IF v_task_id IS NOT NULL THEN
    -- Revalidate at answer time: the task may have changed since the
    -- question was sent.
    SELECT * INTO v_person FROM public.people WHERE id = v_c.person_id;
    SELECT * INTO v_task FROM public.tasks WHERE id = v_task_id;
    IF NOT FOUND OR v_task.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
    END IF;
    IF v_task.status IS DISTINCT FROM 'pending'
       OR lower(btrim(COALESCE(v_task.assigned_to, ''))) <> lower(btrim(COALESCE(v_person.name, ''))) THEN
      RETURN QUERY SELECT 'task_not_eligible'::text, v_c.status, v_c.staff_message_id, v_c.resolved_task_id;
      RETURN;
    END IF;

    -- Fill only a blank link; never overwrite existing evidence.
    UPDATE public.staff_messages m SET task_id = v_task_id
      WHERE m.id = v_c.staff_message_id AND m.user_id = p_user_id AND m.task_id IS NULL;
    UPDATE public.staff_escalation_owner_decisions d SET task_id = v_task_id
      WHERE d.staff_message_id = v_c.staff_message_id AND d.user_id = p_user_id AND d.task_id IS NULL;
  END IF;

  UPDATE public.staff_reply_clarifications c SET
    status = v_status,
    resolved_task_id = v_task_id,
    answer_staff_message_id = p_answer_staff_message_id,
    resolved_at = now()
  WHERE c.id = v_c.id;

  RETURN QUERY SELECT v_status, v_status, v_c.staff_message_id, v_task_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.open_staff_reply_clarification(uuid, uuid, uuid[], text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_staff_reply_clarification(uuid, uuid, uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_staff_reply_clarification(uuid, uuid, uuid[], text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_staff_reply_clarification(uuid, uuid, uuid, integer, uuid) TO service_role;
