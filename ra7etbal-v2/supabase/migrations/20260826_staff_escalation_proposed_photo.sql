/**
 * Additive fix for the substitute-approval production failure (2026-08-26,
 * real test: Christopher, requested TEREA Silver, found only TEREA
 * Turquoise, asked "Is it ok?" with a photo BEFORE purchasing).
 *
 * Root cause (see the accompanying application-code changes): a
 * WhatsApp message carrying media was always routed into the
 * completion-proof pipeline (task-confirm.js / _quality-review.js),
 * regardless of what the caption said, so a genuine pre-action
 * substitution proposal illustrated with a photo could never reach the
 * existing text-based substitution_request / owner-escalation machinery
 * (_staff-comms-engine.js + staff_escalation_owner_decisions) — and that
 * machinery had no field to durably carry a photo even if it had.
 *
 * Schema investigation performed before writing this migration (per
 * explicit authorization: a schema change is approved ONLY if no existing
 * field can safely and durably reference the photo):
 *   - staff_escalation_owner_decisions (20260726_staff_escalation_owner_
 *     decisions.sql): no image/photo column exists.
 *   - staff_messages (20260720_create_staff_messages.sql): no image/photo
 *     column exists either.
 *   - tasks.proof_image_path (pre-existing): rejected deliberately — that
 *     field means "this is the completion proof for this task" and is read
 *     that way throughout task-confirm.js/_quality-review.js. Writing a
 *     pre-action illustrative photo there would recreate, at the storage
 *     layer, the exact same "photo == completed action" conflation that
 *     caused this production defect in the first place.
 * Conclusion: no existing field is semantically correct. An additive
 * nullable column is the smallest correct fix, added to
 * staff_escalation_owner_decisions because that table is the canonical
 * one-row-per-decision record for BOTH the message-triggered
 * (staff_message_id set) and task-triggered (task_id set, staff_message_id
 * null) owner-decision lifecycles, and a pre-action proposal is exactly a
 * new instance of the message-triggered kind.
 *
 * Pattern followed as closely as possible: mirrors notifyOwnerOfTaskReview's
 * existing proofImagePath handling (a plain nullable storage-path text
 * column, read only to mint a signed URL / send a WhatsApp image message —
 * never itself a source of authorization or task state).
 *
 * Additive only: one nullable column, one CREATE OR REPLACE (backward-
 * compatible — the new parameter is optional and defaults to NULL, so
 * every existing caller of claim_escalation_owner_decision keeps working
 * unchanged). No existing row, constraint, index, or RLS policy is
 * touched. Rollback: 20260826_staff_escalation_proposed_photo.rollback.sql.
 */

ALTER TABLE public.staff_escalation_owner_decisions
  ADD COLUMN IF NOT EXISTS proposed_photo_path text NULL;

COMMENT ON COLUMN public.staff_escalation_owner_decisions.proposed_photo_path IS
  'Storage path (task-images bucket) of a photo the staff member attached to a pre-action substitution proposal, when supplied. Never proof of a completed action — see tasks.proof_image_path for that. Set once at claim time only, never overwritten.';

-- CREATE OR REPLACE cannot change a function's parameter list; the old
-- 3-arg signature must be dropped explicitly so exactly one canonical
-- version of this function exists (no lingering overload).
DROP FUNCTION IF EXISTS public.claim_escalation_owner_decision(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.claim_escalation_owner_decision(
  p_staff_message_id     uuid,
  p_user_id              uuid,
  p_task_id              uuid,
  p_proposed_photo_path  text DEFAULT NULL
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
    RETURN v_row; -- idempotent: already claimed for this message, photo path never overwritten on retry
  END IF;

  INSERT INTO public.staff_escalation_owner_decisions (staff_message_id, user_id, task_id, proposed_photo_path)
  VALUES (p_staff_message_id, p_user_id, p_task_id, p_proposed_photo_path)
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

REVOKE EXECUTE ON FUNCTION public.claim_escalation_owner_decision(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_escalation_owner_decision(uuid, uuid, uuid, text) TO service_role;
