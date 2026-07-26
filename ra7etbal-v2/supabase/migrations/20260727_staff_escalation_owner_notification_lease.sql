/**
 * Phase B fix — atomic claim/lease for the owner-notification send step.
 *
 * Follow-up to 20260726_staff_escalation_owner_decisions.sql (already
 * applied to production; NOT edited here). Independent review of PR #86
 * confirmed a real check-then-act race: api/_escalation-notify.js's prior
 * design (SELECT staff_messages.owner_notification_status, decide, send
 * Meta, PATCH status afterward) has no atomicity — two concurrent
 * redeliveries of the same inbound webhook message (a documented Meta
 * behavior, and this handler is slow enough to fall inside Meta's retry
 * window) can both observe 'not_attempted' before either write lands,
 * and both send a real WhatsApp message to the owner.
 *
 * This migration adds a lease-claim mechanism for the OWNER-notification
 * send step specifically, mirroring the exact pattern already proven for
 * claim_escalation_answer_delivery (20260726) and
 * claim_staff_response_delivery (20260724): claim mints a fresh token and
 * moves 'not_attempted'/'failed'/expired-'sending' to 'sending'; only the
 * caller holding the current token may complete or fail; 'sent' is
 * terminal; a live 'sending' lease is not claimable by a second caller.
 *
 * Additive only:
 *  - four new nullable staff_messages columns
 *  - one CHECK-constraint widening (adds 'sending' to the existing
 *    owner_notification_status enum; all four existing values are
 *    unchanged, matching the same DROP+ADD CONSTRAINT pattern already
 *    used in 20260710_quality_substitute_review.sql for
 *    tasks.quality_review_status)
 *  - three new SECURITY DEFINER functions
 * No existing column, constraint (beyond the documented widening), or
 * function signature is modified or removed.
 *
 * Rollback: see the companion file
 * 20260727_staff_escalation_owner_notification_lease.rollback.sql
 */

-- ── staff_messages: additive lease columns ──────────────────────────────────

ALTER TABLE public.staff_messages
  ADD COLUMN IF NOT EXISTS owner_notification_token uuid,
  ADD COLUMN IF NOT EXISTS owner_notification_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS owner_notification_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS owner_notification_error text;

-- Widen the existing owner_notification_status CHECK to add 'sending' as a
-- valid in-flight state. All four pre-existing values are preserved
-- unchanged.
ALTER TABLE public.staff_messages
  DROP CONSTRAINT IF EXISTS staff_messages_owner_notification_status_check;
ALTER TABLE public.staff_messages
  ADD CONSTRAINT staff_messages_owner_notification_status_check
  CHECK (owner_notification_status IN ('not_attempted','sent','skipped_no_phone','failed','sending'));

-- ── Functions ────────────────────────────────────────────────────────────────

-- Claims the owner-notification send step. Claimable from: 'not_attempted'
-- (first attempt), 'failed' (explicit retry — no separate retry function
-- needed), or 'sending' whose lease has expired (reclaim of a crashed/stuck
-- attempt). A live 'sending' lease is NOT claimable — an attempt is
-- genuinely in flight, which is exactly what closes the concurrent-
-- redelivery race. 'sent' is terminal. Every successful claim mints a
-- brand-new token, invalidating whatever token a prior attempt held.
CREATE OR REPLACE FUNCTION public.claim_owner_escalation_notification(
  p_id            uuid,
  p_user_id       uuid,
  p_lease_seconds integer DEFAULT 120
) RETURNS TABLE (
  message_id          uuid,
  claimed              boolean,
  claim_token          uuid,
  notification_status  text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v       public.staff_messages;
  v_token uuid := gen_random_uuid();
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.staff_messages
    WHERE id = p_id AND user_id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  IF v.owner_notification_status = 'sent' THEN
    RETURN QUERY SELECT v.id, false, NULL::uuid, v.owner_notification_status;
    RETURN;
  END IF;

  IF v.owner_notification_status = 'not_attempted'
     OR v.owner_notification_status = 'failed'
     OR (v.owner_notification_status = 'sending' AND v.owner_notification_lease_until <= now()) THEN
    UPDATE public.staff_messages SET
      owner_notification_status = 'sending',
      owner_notification_token = v_token,
      owner_notification_claimed_at = now(),
      owner_notification_lease_until = now() + make_interval(secs => p_lease_seconds),
      owner_notification_error = NULL
    WHERE id = p_id
    RETURNING * INTO v;

    RETURN QUERY SELECT v.id, true, v_token, v.owner_notification_status;
    RETURN;
  END IF;

  -- owner_notification_status = 'sending' with a live (non-expired) lease,
  -- or 'skipped_no_phone' (not directly retried by this claim — a future
  -- product decision can widen this if a later phone-number addition
  -- should re-trigger notification): not claimable by this caller.
  RETURN QUERY SELECT v.id, false, NULL::uuid, v.owner_notification_status;
END;
$$;

-- Atomically records a successful send. Requires the exact live claim
-- token — a stale/duplicate completion callback from a superseded attempt
-- cannot resolve a newer one (SQLSTATE 40001).
CREATE OR REPLACE FUNCTION public.complete_owner_escalation_notification(
  p_id          uuid,
  p_user_id     uuid,
  p_claim_token uuid
) RETURNS public.staff_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v     public.staff_messages;
  v_now timestamptz := now();
BEGIN
  UPDATE public.staff_messages SET
    owner_notification_status = 'sent',
    owner_notified_at = v_now,
    owner_notification_token = NULL,
    owner_notification_lease_until = NULL,
    owner_notification_error = NULL
  WHERE id = p_id
    AND user_id = p_user_id
    AND owner_notification_status = 'sending'
    AND owner_notification_token = p_claim_token
  RETURNING * INTO v;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_notification_claim' USING ERRCODE = '40001';
  END IF;

  RETURN v;
END;
$$;

-- Atomically records a failed send. Same token-gating as complete_... — a
-- stale token cannot mark a newer attempt failed either. Never touches
-- staff_messages.user_facing_state (owned exclusively by
-- complete_escalation_answer_delivery), so a failed owner notification
-- leaves Needs You open by construction, with no extra logic required.
CREATE OR REPLACE FUNCTION public.fail_owner_escalation_notification(
  p_id          uuid,
  p_user_id     uuid,
  p_claim_token uuid,
  p_error       text
) RETURNS public.staff_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.staff_messages;
BEGIN
  UPDATE public.staff_messages SET
    owner_notification_status = 'failed',
    owner_notification_error = left(NULLIF(btrim(p_error), ''), 500),
    owner_notification_token = NULL,
    owner_notification_lease_until = NULL
  WHERE id = p_id
    AND user_id = p_user_id
    AND owner_notification_status = 'sending'
    AND owner_notification_token = p_claim_token
  RETURNING * INTO v;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_notification_claim' USING ERRCODE = '40001';
  END IF;

  RETURN v;
END;
$$;

-- ── Execute grants: service_role only ───────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.claim_owner_escalation_notification(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_owner_escalation_notification(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_owner_escalation_notification(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_owner_escalation_notification(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_owner_escalation_notification(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_owner_escalation_notification(uuid, uuid, uuid, text) TO service_role;
