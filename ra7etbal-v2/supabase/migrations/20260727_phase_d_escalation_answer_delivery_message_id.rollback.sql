/**
 * Rollback for 20260727_phase_d_escalation_answer_delivery_message_id.sql.
 *
 * Reverses the migration exactly: restores complete_escalation_answer_
 * delivery to its original 3-arg Phase A signature/body (dropping the
 * 4-arg version), and drops the additive delivery_transport_message_id
 * column. Nothing else on staff_escalation_owner_decisions or
 * staff_messages is touched — every other column, index, RLS policy, and
 * the other four Phase A functions (claim_escalation_owner_decision,
 * answer_escalation_owner_decision, claim_escalation_answer_delivery,
 * fail_escalation_answer_delivery) are untouched and unaffected.
 */

-- ── complete_escalation_answer_delivery: restore original 3-arg version ────

DROP FUNCTION IF EXISTS public.complete_escalation_answer_delivery(uuid, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.complete_escalation_answer_delivery(
  p_id          uuid,
  p_user_id     uuid,
  p_claim_token uuid
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

  UPDATE public.staff_messages
    SET user_facing_state = 'Completed',
        escalation_resolved_at = v_now
    WHERE id = v.staff_message_id AND user_id = p_user_id;

  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_escalation_answer_delivery(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_escalation_answer_delivery(uuid, uuid, uuid) TO service_role;

-- ── staff_escalation_owner_decisions: drop additive column ──────────────────

ALTER TABLE public.staff_escalation_owner_decisions
  DROP COLUMN IF EXISTS delivery_transport_message_id;
