/**
 * Phase A — Owner Escalation Loop: schema only.
 *
 * Additive infrastructure for the owner-decision half of the staff
 * escalation loop (issue traced in the Phase 1 architecture review,
 * corrected 2026-07-26). No application code references these objects yet
 * — this migration is schema-only, verified on an isolated Supabase
 * development branch, not applied to production as part of this task.
 *
 * Mirrors two existing, already-locked patterns in this codebase:
 *  - supabase/migrations/20260720_create_staff_messages.sql (claim/complete/
 *    fail SECURITY DEFINER lifecycle, owner-only RLS SELECT, no direct
 *    write grant to authenticated/anon)
 *  - supabase/migrations/20260710_quality_substitute_review.sql (claim/
 *    reserve/complete lease pattern with a token + lease_until column pair
 *    guarding exactly-once delivery)
 *
 * Nothing here modifies an existing table's constraints, an existing RPC's
 * signature, or staff_messages' existing classification/response-delivery
 * columns — those stay byte-for-byte untouched (see the three additive
 * columns added at the bottom of this file).
 *
 * Rollback: see the companion file
 * 20260726_staff_escalation_owner_decisions.rollback.sql
 */

-- ── staff_escalation_owner_decisions ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_escalation_owner_decisions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- One decision row per escalation. UNIQUE enforces this at the schema
  -- level — claim_escalation_owner_decision relies on it for idempotency.
  staff_message_id      uuid        NOT NULL UNIQUE
                                     REFERENCES public.staff_messages(id) ON DELETE CASCADE,
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id               uuid        NULL REFERENCES public.tasks(id) ON DELETE SET NULL,

  status                text        NOT NULL DEFAULT 'open'
                                     CHECK (status IN ('open','answered','delivering','delivered_to_staff','failed')),

  owner_reply_text      text        NULL,
  owner_reply_channel   text        NULL DEFAULT 'app'
                                     CHECK (owner_reply_channel IS NULL OR owner_reply_channel IN ('app')),
  answered_at           timestamptz NULL,

  -- Deep-link auth: a separate, non-guessable value from `id`. `id` is
  -- never exposed to the unauthenticated deep-link interface (Phase C);
  -- deep_link_token is the only value that interface accepts.
  deep_link_token       uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),

  -- Delivery lease (mirrors quality_substitute_decisions / the
  -- staff_messages response-delivery columns): a fresh token is minted on
  -- every claim, so a stale token from a superseded attempt can never
  -- complete or fail a newer one.
  delivery_token        uuid        NULL,
  delivery_claimed_at   timestamptz NULL,
  delivery_lease_until  timestamptz NULL,
  delivered_at          timestamptz NULL,
  delivery_failed_at    timestamptz NULL,
  delivery_error        text        NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_escalation_owner_decisions_user_status_idx
  ON public.staff_escalation_owner_decisions (user_id, status);
CREATE INDEX IF NOT EXISTS staff_escalation_owner_decisions_task_id_idx
  ON public.staff_escalation_owner_decisions (task_id)
  WHERE task_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_staff_escalation_owner_decisions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_staff_escalation_owner_decisions_updated_at
BEFORE UPDATE ON public.staff_escalation_owner_decisions
FOR EACH ROW
EXECUTE FUNCTION public.set_staff_escalation_owner_decisions_updated_at();

-- ── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE public.staff_escalation_owner_decisions ENABLE ROW LEVEL SECURITY;

-- Owner-only read, same pattern as staff_messages: a row's user_id is fixed
-- at claim time (claim_escalation_owner_decision verifies the linked
-- staff_messages row belongs to the caller's user_id), so this policy alone
-- prevents cross-household visibility.
CREATE POLICY "staff_escalation_owner_decisions: owner can select"
  ON public.staff_escalation_owner_decisions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policy for authenticated/anon. All writes go
-- through the SECURITY DEFINER functions below — same discipline as
-- staff_messages and quality_substitute_decisions: service_role technically
-- bypasses RLS regardless of policy, so the guarantee that every write is
-- validated comes from the application layer only ever calling these
-- functions, not from a Postgres-enforced barrier against service_role.

GRANT SELECT ON public.staff_escalation_owner_decisions TO authenticated;

-- ── Functions ────────────────────────────────────────────────────────────────

-- Idempotent claim: one row per staff_message_id. A retry (e.g. a webhook
-- redelivery reaching this call again) returns the existing row unchanged
-- rather than raising a unique-violation or creating a second escalation.
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

  INSERT INTO public.staff_escalation_owner_decisions (staff_message_id, user_id, task_id)
  VALUES (p_staff_message_id, p_user_id, p_task_id)
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

-- Records the owner's answer, exactly once. Only open -> answered is a real
-- transition; any later state (answered/delivering/delivered_to_staff)
-- returns the row unchanged and silently ignores p_owner_reply_text — a
-- double-submit (refresh, resubmit, replay) can never overwrite the first
-- recorded answer. Authorization here is by token possession only (the
-- deep-link interface has no Supabase session to check against) — this
-- mirrors the existing unauthenticated /confirm?task= worker/owner-decision
-- pattern already in production.
CREATE OR REPLACE FUNCTION public.answer_escalation_owner_decision(
  p_deep_link_token  uuid,
  p_owner_reply_text text
) RETURNS public.staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.staff_escalation_owner_decisions;
BEGIN
  IF p_owner_reply_text IS NULL OR btrim(p_owner_reply_text) = '' THEN
    RAISE EXCEPTION 'empty_reply' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.staff_escalation_owner_decisions
    WHERE deep_link_token = p_deep_link_token
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  IF v.status IN ('answered', 'delivering', 'delivered_to_staff') THEN
    RETURN v; -- idempotent no-op: never overwrites an existing answer
  END IF;

  IF v.status <> 'open' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_escalation_owner_decisions
    SET status = 'answered',
        owner_reply_text = btrim(p_owner_reply_text),
        owner_reply_channel = 'app',
        answered_at = now()
    WHERE id = v.id
    RETURNING * INTO v;

  RETURN v;
END;
$$;

-- Claims a delivery attempt. Claimable from: 'answered' (first attempt),
-- 'failed' (explicit retry — a failed row is claimable again with no
-- separate retry function needed), or 'delivering' whose lease has expired
-- (reclaim of a crashed/stuck attempt). A live 'delivering' lease is NOT
-- claimable (an attempt is genuinely in flight) and 'delivered_to_staff' is
-- terminal. Every successful claim mints a brand-new delivery_token,
-- invalidating whatever token a prior attempt held.
CREATE OR REPLACE FUNCTION public.claim_escalation_answer_delivery(
  p_id            uuid,
  p_user_id       uuid,
  p_lease_seconds integer DEFAULT 120
) RETURNS TABLE (
  row_id          uuid,
  claimed         boolean,
  claim_token     uuid,
  reply_text      text,
  delivery_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v       public.staff_escalation_owner_decisions;
  v_token uuid := gen_random_uuid();
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.staff_escalation_owner_decisions
    WHERE id = p_id AND user_id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  IF v.status = 'delivered_to_staff' THEN
    RETURN QUERY SELECT v.id, false, NULL::uuid, v.owner_reply_text, v.status;
    RETURN;
  END IF;

  IF v.status = 'answered'
     OR v.status = 'failed'
     OR (v.status = 'delivering' AND v.delivery_lease_until <= now()) THEN
    UPDATE public.staff_escalation_owner_decisions SET
      status = 'delivering',
      delivery_token = v_token,
      delivery_claimed_at = now(),
      delivery_lease_until = now() + make_interval(secs => p_lease_seconds),
      delivery_error = NULL
    WHERE id = p_id
    RETURNING * INTO v;

    RETURN QUERY SELECT v.id, true, v_token, v.owner_reply_text, v.status;
    RETURN;
  END IF;

  -- status = 'delivering' with a live (non-expired) lease: genuinely
  -- in-flight, not claimable — prevents a concurrent double-send.
  RETURN QUERY SELECT v.id, false, NULL::uuid, v.owner_reply_text, v.status;
END;
$$;

-- Atomic completion. Both the escalation row and the linked staff_messages
-- row move together inside this single function call (one implicit
-- transaction): if the staff_messages update were ever to fail, the
-- preceding escalation-row update rolls back with it — never a partial
-- state where one is resolved and the other is not. Gated on the exact
-- live delivery_token, so a stale/duplicate completion callback from a
-- superseded attempt cannot resolve a newer one.
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

  -- Same function call = same implicit transaction as the update above:
  -- both rows resolve together, or neither does.
  UPDATE public.staff_messages
    SET user_facing_state = 'Completed',
        escalation_resolved_at = v_now
    WHERE id = v.staff_message_id AND user_id = p_user_id;

  RETURN v;
END;
$$;

-- Guarded delivering -> failed transition. Deliberately never touches
-- staff_messages: user_facing_state was never advanced past 'Needs You'
-- until complete_escalation_answer_delivery runs, so a failed delivery
-- leaves it there by construction, with no extra logic required. Same
-- token-gating as complete_... — a stale token cannot mark a newer attempt
-- failed either.
CREATE OR REPLACE FUNCTION public.fail_escalation_answer_delivery(
  p_id          uuid,
  p_user_id     uuid,
  p_claim_token uuid,
  p_error       text
) RETURNS public.staff_escalation_owner_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.staff_escalation_owner_decisions;
BEGIN
  UPDATE public.staff_escalation_owner_decisions SET
    status = 'failed',
    delivery_failed_at = now(),
    delivery_error = left(NULLIF(btrim(p_error), ''), 500),
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

  RETURN v;
END;
$$;

-- ── Execute grants: service_role only ───────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.claim_escalation_owner_decision(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.answer_escalation_owner_decision(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_escalation_answer_delivery(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_escalation_answer_delivery(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_escalation_answer_delivery(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_escalation_owner_decision(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.answer_escalation_owner_decision(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_escalation_answer_delivery(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_escalation_answer_delivery(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_escalation_answer_delivery(uuid, uuid, uuid, text) TO service_role;

-- ── staff_messages: minimum additive columns ────────────────────────────────
-- No existing column, constraint, or RPC signature on staff_messages is
-- modified. These three columns are purely additive and untouched by
-- existing classification/response-delivery code paths.

ALTER TABLE public.staff_messages
  ADD COLUMN IF NOT EXISTS owner_notification_status text NOT NULL DEFAULT 'not_attempted'
    CHECK (owner_notification_status IN ('not_attempted','sent','skipped_no_phone','failed')),
  ADD COLUMN IF NOT EXISTS owner_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalation_resolved_at timestamptz;
