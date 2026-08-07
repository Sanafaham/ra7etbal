/**
 * Owner WhatsApp reply — inbound idempotency receipt.
 *
 * Root cause this exists to fix: a Meta webhook redelivery of the same
 * inbound owner WhatsApp message must never be processed twice. The
 * existing Phase A-D escalation RPCs (claim/answer/complete/fail_
 * escalation_answer_delivery) already guarantee exactly-once *resolution*
 * and exactly-once *staff delivery* once an escalation is actually being
 * answered — but they are never called at all for the clarification path
 * (ambiguous reply, multiple open escalations, zero match), so nothing
 * currently stops a redelivered webhook from sending a second, duplicate
 * clarification message. Separately, even for the single-open-escalation
 * case, re-running correlation on a redelivery observes a *different*
 * open-escalation count than the first delivery did (the escalation is no
 * longer open once resolved), which would incorrectly trigger a confusing
 * "couldn't match" reply on the second delivery even though the first one
 * already succeeded.
 *
 * This table is the single, durable claim point for "have I already
 * finished responding to this exact inbound WhatsApp message" — checked
 * first, before any owner/escalation correlation, before any
 * classification, before any RPC call. It never overlaps with
 * staff_messages (an owner's own reply must never become a fake staff
 * message row — see RA7ETBAL_STATE.md's owner-WhatsApp-reply
 * investigation) and never overlaps with the existing per-escalation
 * delivery lease on staff_escalation_owner_decisions — this is purely an
 * inbound-webhook-level dedupe, one row per (user_id,
 * external_message_id).
 *
 * Same claim/complete/fail lease shape already proven three times in this
 * codebase (claim_staff_response_delivery, claim_owner_escalation_
 * notification, claim_escalation_answer_delivery): claim mints a fresh
 * token and is claimable from 'claimed' only once its lease has expired
 * (crash/stuck-attempt recovery), or from 'failed' (explicit retry — our
 * own processing errored, not a business-outcome). 'completed' is
 * terminal and never reclaimable: any outcome that already caused an
 * outbound WhatsApp send (a resolved escalation, a clarification, or a
 * truthful zero-match reply) must never be repeated on redelivery.
 *
 * Rollback: see the companion file
 * 20260727_owner_whatsapp_reply_receipts.rollback.sql
 */

-- ── owner_whatsapp_reply_receipts ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.owner_whatsapp_reply_receipts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Meta's own inbound message id (msg.messageId — raw.id from the webhook
  -- payload). One row per (user_id, external_message_id): a redelivery of
  -- the exact same inbound message can never create a second row.
  external_message_id  text        NOT NULL,

  status                text        NOT NULL DEFAULT 'claimed'
                                     CHECK (status IN ('claimed','completed','failed')),

  -- Set only on completion — what actually happened for this inbound
  -- message. 'resolved_escalation' means the shared Phase D helper ran
  -- (whatever its own outcome — delivered, in_progress, saved_unreachable,
  -- sent_unconfirmed — all of those are still "we resolved and acted on
  -- an escalation", never re-attempted on redelivery either way).
  outcome                text        NULL
                                     CHECK (outcome IS NULL OR outcome IN (
                                       'resolved_escalation',
                                       'clarification_sent',
                                       'zero_match'
                                     )),
  escalation_id          uuid        NULL REFERENCES public.staff_escalation_owner_decisions(id) ON DELETE SET NULL,

  claim_token            uuid        NULL,
  claimed_at             timestamptz NOT NULL DEFAULT now(),
  lease_until            timestamptz NULL,
  completed_at           timestamptz NULL,
  failed_at              timestamptz NULL,
  error                  text        NULL,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS owner_whatsapp_reply_receipts_user_external_message_id_key
  ON public.owner_whatsapp_reply_receipts (user_id, external_message_id);

CREATE INDEX IF NOT EXISTS owner_whatsapp_reply_receipts_escalation_id_idx
  ON public.owner_whatsapp_reply_receipts (escalation_id)
  WHERE escalation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_owner_whatsapp_reply_receipts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_owner_whatsapp_reply_receipts_updated_at
BEFORE UPDATE ON public.owner_whatsapp_reply_receipts
FOR EACH ROW
EXECUTE FUNCTION public.set_owner_whatsapp_reply_receipts_updated_at();

-- ── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE public.owner_whatsapp_reply_receipts ENABLE ROW LEVEL SECURITY;

-- Owner-only read (audit/debugging visibility only — no product surface
-- reads this table today). All writes go through the SECURITY DEFINER
-- functions below, same discipline as every other lease table in this
-- codebase.
CREATE POLICY "owner_whatsapp_reply_receipts: owner can select"
  ON public.owner_whatsapp_reply_receipts
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

GRANT SELECT ON public.owner_whatsapp_reply_receipts TO authenticated;

-- ── Functions ────────────────────────────────────────────────────────────────

-- Claims processing rights for one inbound owner WhatsApp message. Claimable
-- from: no existing row (first delivery — inserts fresh), 'failed' (retry
-- after our own processing error), or 'claimed' whose lease has expired
-- (crash/stuck-attempt recovery). A live 'claimed' lease is NOT claimable —
-- an attempt is genuinely in flight, which is exactly what closes the
-- concurrent-redelivery race. 'completed' is terminal and never
-- reclaimable: we already finished responding to this message once.
CREATE OR REPLACE FUNCTION public.claim_owner_whatsapp_reply(
  p_user_id             uuid,
  p_external_message_id text,
  p_lease_seconds       integer DEFAULT 120
) RETURNS TABLE (
  receipt_id  uuid,
  claimed     boolean,
  claim_token uuid,
  status      text,
  outcome     text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v       public.owner_whatsapp_reply_receipts;
  v_token uuid := gen_random_uuid();
  v_msg   text;
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
  END IF;

  v_msg := NULLIF(btrim(p_external_message_id), '');
  IF p_user_id IS NULL OR v_msg IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;

  -- Try the fast path first: this is a brand-new inbound message.
  INSERT INTO public.owner_whatsapp_reply_receipts (
    user_id, external_message_id, status, claim_token, claimed_at, lease_until
  ) VALUES (
    p_user_id, v_msg, 'claimed', v_token, now(), now() + make_interval(secs => p_lease_seconds)
  )
  ON CONFLICT (user_id, external_message_id) DO NOTHING
  RETURNING * INTO v;

  IF FOUND THEN
    RETURN QUERY SELECT v.id, true, v_token, v.status, v.outcome;
    RETURN;
  END IF;

  -- A row already exists — lock it and decide whether it's reclaimable.
  SELECT * INTO v FROM public.owner_whatsapp_reply_receipts
    WHERE user_id = p_user_id AND external_message_id = v_msg
    FOR UPDATE;

  IF v.status = 'completed' THEN
    RETURN QUERY SELECT v.id, false, NULL::uuid, v.status, v.outcome;
    RETURN;
  END IF;

  IF v.status = 'failed' OR (v.status = 'claimed' AND v.lease_until <= now()) THEN
    UPDATE public.owner_whatsapp_reply_receipts SET
      status = 'claimed',
      claim_token = v_token,
      claimed_at = now(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      error = NULL
    WHERE id = v.id
    RETURNING * INTO v;

    RETURN QUERY SELECT v.id, true, v_token, v.status, v.outcome;
    RETURN;
  END IF;

  -- status = 'claimed' with a live (non-expired) lease: genuinely in
  -- flight, not claimable — this is the actual concurrent-redelivery guard.
  RETURN QUERY SELECT v.id, false, NULL::uuid, v.status, v.outcome;
END;
$$;

-- Atomically records successful completion. Requires the exact live claim
-- token — a stale/duplicate completion callback from a superseded attempt
-- cannot resolve a newer one. Terminal: never claimable again afterward.
CREATE OR REPLACE FUNCTION public.complete_owner_whatsapp_reply(
  p_id           uuid,
  p_user_id      uuid,
  p_claim_token  uuid,
  p_outcome      text,
  p_escalation_id uuid DEFAULT NULL
) RETURNS public.owner_whatsapp_reply_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.owner_whatsapp_reply_receipts;
BEGIN
  IF p_outcome NOT IN ('resolved_escalation', 'clarification_sent', 'zero_match') THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023';
  END IF;

  UPDATE public.owner_whatsapp_reply_receipts SET
    status = 'completed',
    outcome = p_outcome,
    escalation_id = p_escalation_id,
    completed_at = now(),
    claim_token = NULL,
    lease_until = NULL,
    error = NULL
  WHERE id = p_id
    AND user_id = p_user_id
    AND status = 'claimed'
    AND claim_token = p_claim_token
  RETURNING * INTO v;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_receipt_claim' USING ERRCODE = '40001';
  END IF;

  RETURN v;
END;
$$;

-- Atomically records a processing failure — retryable via
-- claim_owner_whatsapp_reply on the next redelivery. Same token-gating as
-- complete_... — a stale token cannot mark a newer attempt failed either.
CREATE OR REPLACE FUNCTION public.fail_owner_whatsapp_reply(
  p_id          uuid,
  p_user_id     uuid,
  p_claim_token uuid,
  p_error       text
) RETURNS public.owner_whatsapp_reply_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.owner_whatsapp_reply_receipts;
BEGIN
  UPDATE public.owner_whatsapp_reply_receipts SET
    status = 'failed',
    failed_at = now(),
    error = left(NULLIF(btrim(p_error), ''), 500),
    claim_token = NULL,
    lease_until = NULL
  WHERE id = p_id
    AND user_id = p_user_id
    AND status = 'claimed'
    AND claim_token = p_claim_token
  RETURNING * INTO v;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_receipt_claim' USING ERRCODE = '40001';
  END IF;

  RETURN v;
END;
$$;

-- ── Execute grants: service_role only ───────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.claim_owner_whatsapp_reply(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_owner_whatsapp_reply(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_owner_whatsapp_reply(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_owner_whatsapp_reply(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_owner_whatsapp_reply(uuid, uuid, uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_owner_whatsapp_reply(uuid, uuid, uuid, text) TO service_role;
