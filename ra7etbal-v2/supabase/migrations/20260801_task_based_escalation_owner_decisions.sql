/**
 * Task-based owner-decision escalation support.
 *
 * The existing staff_escalation_owner_decisions table was designed around
 * WhatsApp staff messages (staff_message_id NOT NULL). This migration
 * extends it to also cover task-confirm-triggered review events
 * (uncertain proof, substitute_review) that have no WhatsApp staff message.
 *
 * All changes are additive. No existing column, constraint (beyond the
 * documented nullable relaxation), function signature, or RLS policy is
 * removed — only widened or supplemented.
 *
 * After this migration the table supports two creation paths:
 *   a) WhatsApp escalation: staff_message_id set, review_type='staff_escalation'
 *      (created by existing claim_escalation_owner_decision RPC, unchanged)
 *   b) Task-based review: staff_message_id NULL, task_id set,
 *      review_type in ('uncertain_proof','substitute_review','correction_limit')
 *      (created by the new claim_task_escalation_owner_decision RPC below)
 *
 * Rollback: see 20260801_task_based_escalation_owner_decisions.rollback.sql
 */

-- ── 1. Relax staff_message_id to nullable ────────────────────────────────────
-- Safe: existing rows all have non-null values; this only unlocks new rows.
ALTER TABLE public.staff_escalation_owner_decisions
  ALTER COLUMN staff_message_id DROP NOT NULL;

-- ── 2. Add review_type column ────────────────────────────────────────────────
ALTER TABLE public.staff_escalation_owner_decisions
  ADD COLUMN IF NOT EXISTS review_type text NOT NULL DEFAULT 'staff_escalation'
    CHECK (review_type IN ('staff_escalation','uncertain_proof','substitute_review','correction_limit'));

-- ── 3. Add owner_notified_at column (notification idempotency for task-based) ─
ALTER TABLE public.staff_escalation_owner_decisions
  ADD COLUMN IF NOT EXISTS owner_notified_at timestamptz;

-- ── 4. Partial unique index for task-based rows ──────────────────────────────
-- Ensures at most one open/in-flight decision per task when staff_message_id
-- is NULL. Does not affect the existing WhatsApp-escalation unique constraint
-- (which is on the staff_message_id column itself and handles NULLs correctly
-- in PostgreSQL — NULLs are not considered equal for UNIQUE, so multiple
-- NULL rows are already allowed without this index).
CREATE UNIQUE INDEX IF NOT EXISTS staff_escalation_owner_decisions_task_only_open_idx
  ON public.staff_escalation_owner_decisions (task_id)
  WHERE staff_message_id IS NULL
    AND status NOT IN ('delivered_to_staff', 'failed');

-- ── 5. Index for task_id lookups on task-based rows ──────────────────────────
CREATE INDEX IF NOT EXISTS staff_escalation_owner_decisions_task_only_idx
  ON public.staff_escalation_owner_decisions (task_id)
  WHERE staff_message_id IS NULL;

-- ── 6. New RPC: claim_task_escalation_owner_decision ────────────────────────
-- Idempotent: if an open/in-flight row already exists for this task_id
-- (staff_message_id IS NULL), returns it unchanged. Otherwise creates one.
-- Authorization: task must belong to p_user_id.
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
  -- Validate review_type
  IF p_review_type NOT IN ('uncertain_proof', 'substitute_review', 'correction_limit') THEN
    RAISE EXCEPTION 'invalid_review_type' USING ERRCODE = '22023';
  END IF;

  -- Verify task ownership
  PERFORM 1 FROM public.tasks WHERE id = p_task_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  -- Return existing open/in-flight row (idempotent)
  SELECT * INTO v_row FROM public.staff_escalation_owner_decisions
    WHERE task_id = p_task_id
      AND staff_message_id IS NULL
      AND status NOT IN ('delivered_to_staff', 'failed')
    FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  -- Create new row
  INSERT INTO public.staff_escalation_owner_decisions (
    staff_message_id, user_id, task_id, review_type
  ) VALUES (
    NULL, p_user_id, p_task_id, p_review_type
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- Race: another concurrent call won the insert — fetch the winner
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
