/**
 * Durable person attribution for Communication History evidence.
 *
 * Problem: staff_escalation_owner_decisions.task_id and
 * whatsapp_deliveries.task_id are ON DELETE SET NULL against tasks.id.
 * Task deletion (Clear History, voice "delete that task") is a real,
 * intentional, actively-used feature -- not a bug -- but it silently
 * orphans these evidence rows' only linking key, making
 * get_communication_history's wave-2 join permanently unable to find
 * them again, even though the rows themselves (and their content)
 * survive intact.
 *
 * Fix: add a durable person_id column to both tables, populated at
 * write time from an already-resolved person identity that exists
 * independent of the task. This column is never affected by task
 * deletion. Legacy task/message-based linkage is preserved as a
 * fallback for older rows that predate this column.
 *
 * This migration is additive only:
 *   - two new nullable columns
 *   - two new indexes
 *   - two new FK constraints (on the new columns only -- both tables
 *     start with zero existing values in these columns, so there is
 *     no pre-existing-data conflict)
 *   - a deterministic-only backfill (see below)
 *
 * Nothing about task deletion, Clear History, or the existing
 * ON DELETE SET NULL/CASCADE behavior on task_id is changed here.
 *
 * messages.person_id already exists as a plain uuid column (no FK).
 * It is intentionally NOT given an FK constraint in this migration --
 * one existing row's value does not match any real people.id, and
 * repairing or nulling pre-existing data is out of scope here. This
 * migration only makes messages.person_id reliably populated *going
 * forward*, at the application layer (see accompanying code changes).
 *
 * Backfill scope -- deterministic evidence only, no heuristics:
 *   - staff_escalation_owner_decisions.person_id: from
 *     staff_messages.person_id via the surviving staff_message_id FK.
 *     staff_message_id is never touched by task deletion (only the
 *     task_id column is), so every row that still has a real
 *     staff_message_id can be recovered with certainty.
 *   - whatsapp_deliveries.person_id: from staff_messages.person_id via
 *     the metadata->>'staff_message_id' value some rows carry (set by
 *     the caller, not a formal FK, but a real recorded identifier);
 *     and separately from messages.person_id via message_id, only
 *     when messages.person_id is already a real, non-null value.
 *     No timestamp proximity, no text/name matching, no task
 *     description matching.
 *
 * Rows that cannot be tied to a person through one of these exact
 * paths are left NULL -- reported as unrecoverable, not guessed.
 *
 * Rollback: see 20260812_durable_person_id_communication_history.rollback.sql
 */

-- ── 1. staff_escalation_owner_decisions.person_id ────────────────────────────

ALTER TABLE public.staff_escalation_owner_decisions
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.people(id);

CREATE INDEX IF NOT EXISTS staff_escalation_owner_decisions_person_id_idx
  ON public.staff_escalation_owner_decisions (person_id)
  WHERE person_id IS NOT NULL;

-- ── 2. whatsapp_deliveries.person_id ──────────────────────────────────────────

ALTER TABLE public.whatsapp_deliveries
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.people(id);

CREATE INDEX IF NOT EXISTS whatsapp_deliveries_person_id_idx
  ON public.whatsapp_deliveries (person_id)
  WHERE person_id IS NOT NULL;

-- ── 3. claim_escalation_owner_decision: populate person_id at write time ─────
-- The function already loads the full staff_messages row into v_msg before
-- inserting (for the authorization check) -- v_msg.person_id was simply
-- unused until now. This is the only change to this function's body.

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
    RETURN v_row; -- idempotent: already claimed for this message
  END IF;

  INSERT INTO public.staff_escalation_owner_decisions (staff_message_id, user_id, task_id, person_id)
  VALUES (p_staff_message_id, p_user_id, p_task_id, v_msg.person_id)
  ON CONFLICT (staff_message_id) DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- Lost a race to a concurrent claim for the same staff_message_id.
    SELECT * INTO v_row FROM public.staff_escalation_owner_decisions
      WHERE staff_message_id = p_staff_message_id;
  END IF;

  RETURN v_row;
END;
$$;

-- claim_task_escalation_owner_decision (the task-based review path, no
-- staff message) is intentionally NOT changed -- tasks has no person_id
-- column, so there is no deterministic source to populate person_id from
-- for that creation path. Those rows correctly keep person_id NULL.

-- ── 4. Deterministic backfill ─────────────────────────────────────────────────

-- staff_escalation_owner_decisions: via surviving staff_message_id -> staff_messages.person_id
UPDATE public.staff_escalation_owner_decisions seod
SET person_id = sm.person_id
FROM public.staff_messages sm
WHERE seod.staff_message_id = sm.id
  AND seod.person_id IS NULL
  AND sm.person_id IS NOT NULL;

-- whatsapp_deliveries: via metadata->>'staff_message_id' -> staff_messages.person_id
UPDATE public.whatsapp_deliveries wd
SET person_id = sm.person_id
FROM public.staff_messages sm
WHERE wd.metadata ? 'staff_message_id'
  AND sm.id = (wd.metadata->>'staff_message_id')::uuid
  AND wd.person_id IS NULL
  AND sm.person_id IS NOT NULL;

-- whatsapp_deliveries: via message_id -> messages.person_id, only when
-- messages.person_id is already a real, non-null value that itself
-- resolves to a real people row. messages.person_id has no FK (see
-- above) -- its one existing non-null value in production does not
-- match any real people.id, so this extra EXISTS guard is required to
-- avoid propagating an already-broken value into a column that does
-- have a real FK. Still fully deterministic: only copies a value that
-- independently proves out, never guesses.
UPDATE public.whatsapp_deliveries wd
SET person_id = m.person_id
FROM public.messages m
WHERE wd.message_id = m.id
  AND wd.person_id IS NULL
  AND m.person_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.people p WHERE p.id = m.person_id);
