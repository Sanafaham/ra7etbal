/**
 * Phase D — Meta transport message id on the escalation answer-delivery
 * lease, plus full staff_messages resolution on completion.
 *
 * Follow-up to 20260726_staff_escalation_owner_decisions.sql (Phase A,
 * already applied to production; NOT edited here — every column, index,
 * RLS policy, and the other four functions on that migration are
 * untouched). Confirmed before writing this migration: none of
 * claim_escalation_answer_delivery, complete_escalation_answer_delivery,
 * fail_escalation_answer_delivery, or answer_escalation_owner_decision has
 * a single runtime caller anywhere in api/ or src/ as of this migration —
 * verified by direct repository search — so widening
 * complete_escalation_answer_delivery's signature carries zero behavioral
 * risk to any code path that exists today.
 *
 * Two changes:
 *
 * 1. staff_escalation_owner_decisions gains one additive, nullable column
 *    (delivery_transport_message_id) — mirrors the existing precedent
 *    staff_messages.response_transport_message_id
 *    (20260724_staff_message_response_delivery.sql), which already stores
 *    Meta's wamid for the parallel "Carson's own reply to staff" send.
 *    Without this column, the escalation row itself cannot answer "what
 *    was Meta's message id for this specific delivery" — the one concrete
 *    audit gap identified in the Phase D design review.
 *
 * 2. complete_escalation_answer_delivery is replaced (old 3-arg signature
 *    dropped, new 4-arg signature created) to accept and store that
 *    transport message id, and to fully resolve the linked staff_messages
 *    row on completion: user_facing_state='Completed',
 *    escalation_resolved_at=now() (both already present in the original
 *    Phase A function — unchanged here), plus two fields the original
 *    function left untouched: owner_attention_required=false and
 *    next_action_owner='nobody' — both exist specifically to describe
 *    "whose turn is it" and were stale (still 'owner'/true from escalation
 *    time) even after full resolution until now. Same atomic single-
 *    transaction guarantee as the original: both rows move together or
 *    neither does. Same stale-token protection: gated on the exact live
 *    delivery_token, unchanged.
 *
 * claim_escalation_answer_delivery, fail_escalation_answer_delivery, and
 * answer_escalation_owner_decision are not modified by this migration —
 * reproduced here unchanged only for the rollback file's reference.
 *
 * Rollback: see the companion file
 * 20260727_phase_d_escalation_answer_delivery_message_id.rollback.sql
 */

-- ── staff_escalation_owner_decisions: additive column ───────────────────────

ALTER TABLE public.staff_escalation_owner_decisions
  ADD COLUMN IF NOT EXISTS delivery_transport_message_id text NULL;

-- ── complete_escalation_answer_delivery: widened signature ──────────────────

DROP FUNCTION IF EXISTS public.complete_escalation_answer_delivery(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.complete_escalation_answer_delivery(
  p_id                    uuid,
  p_user_id               uuid,
  p_claim_token           uuid,
  p_transport_message_id  text DEFAULT NULL
) RETURNS public.staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v     public.staff_escalation_owner_decisions;
  v_now timestamptz := now();
BEGIN
  UPDATE public.staff_escalation_owner_decisions SET
    status = 'delivered_to_staff',
    delivered_at = v_now,
    delivery_transport_message_id = NULLIF(btrim(p_transport_message_id), ''),
    delivery_token = NULL,
    delivery_lease_until = NULL
  WHERE id = p_id
    AND user_id = p_user_id
    AND status = 'delivering'
    AND delivery_token = p_claim_token
  RETURNING * INTO v;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_delivery_claim' USING ERRCODE = '40001';
  END IF;

  -- Same function call = same implicit transaction as the update above:
  -- both rows resolve together, or neither does. owner_attention_required
  -- and next_action_owner are now fully resolved here too — previously
  -- left stale at their escalation-time values (true / 'owner') even after
  -- the escalation was genuinely closed.
  UPDATE public.staff_messages
    SET user_facing_state = 'Completed',
        escalation_resolved_at = v_now,
        owner_attention_required = false,
        next_action_owner = 'nobody'
    WHERE id = v.staff_message_id AND user_id = p_user_id;

  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_escalation_answer_delivery(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_escalation_answer_delivery(uuid, uuid, uuid, text) TO service_role;
