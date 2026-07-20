/**
 * Staff communication engine — persistence for transport-independent
 * staff-to-Carson messages (Issue #46).
 *
 * This table and its four functions (claim_staff_message,
 * complete_staff_message, fail_staff_message, retry_staff_message) are the
 * single canonical staff-message processing path. Any future transport —
 * WhatsApp inbound, a rebuilt ElevenLabs bridge, or anything else — must
 * call through the same application-layer engine built on top of these
 * functions, not a separate implementation. There is only one Carson; this
 * is its one staff-processing entry point regardless of transport.
 *
 * RLS/ownership pattern follows carson_persistent_memory (owner-only
 * SELECT, auth.uid() default) and quality_substitute_decisions (writes via
 * SECURITY DEFINER functions). Note on why, precisely: service_role
 * bypasses Postgres RLS entirely by design and is technically capable of
 * inserting or updating this table directly — no policy here blocks that,
 * and these functions are not a technical barrier that prevents it. They
 * exist so household-ownership validation (person_id/task_id belong to
 * user_id, sender is not a family member, source is supported, etc.) is
 * always co-located with the write inside one atomic call — a discipline
 * the application layer commits to by only ever calling these functions,
 * not a restriction Postgres enforces against service_role itself.
 *
 * Idempotency: claim_staff_message() is the only insert path. It is keyed
 * on (user_id, source, external_message_id) — scoped per transport, so a
 * short id such as "msg-1" reused by two different transports/tests is
 * never mistaken for the same message. A duplicate claim returns the
 * existing row's id/status (is_new = false) instead of raising an
 * unhandled unique-violation or creating a second side effect.
 *
 * Processing lifecycle (processing_status) is internal and distinct from
 * the product-facing user_facing_state: claimed -> completed (normal path,
 * via complete_staff_message), claimed -> failed (via fail_staff_message,
 * when classification/response generation errors out before producing a
 * result), or failed -> claimed (via retry_staff_message, an explicit
 * server-side recovery action — never triggered automatically by a
 * duplicate inbound delivery). All three transition functions are
 * idempotent no-ops when called again on a row already in their target
 * state, and reject any other transition — a claimed row can never be
 * silently overwritten twice, a completed row can never be marked failed
 * after the fact, and a completed row can never be reset to claimed.
 *
 * retry_staff_message() returns is_retried explicitly so its caller can
 * tell a genuine reclaim apart from an already-claimed no-op: only
 * is_retried = true means THIS call performed the failed -> claimed
 * transition. A caller must gate all further work on is_retried = true —
 * restarting classification, generating a response, or creating any other
 * side effect on a call that returned is_retried = false (whether because
 * the row was already claimed, e.g. by a concurrent retry, or for any
 * other reason) would risk duplicate processing.
 */

-- ── staff_messages ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_messages (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owner/household. No column default of auth.uid() — service-role writes
  -- (the only writes this table gets) run without a JWT, so auth.uid() would
  -- be NULL. user_id is always supplied explicitly by claim_staff_message().
  user_id                   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Staff identity. Verified against people at claim time: must belong to
  -- user_id and must not be is_family. person_id is nullable + ON DELETE
  -- SET NULL so a later person deletion preserves message history instead
  -- of cascading it away. staff_name/staff_phone are snapshots taken from
  -- the verified people row at claim time (never caller-supplied) and
  -- remain the record of who actually sent the message even after
  -- person_id is nulled out. staff_name is NOT NULL: people.name is itself
  -- NOT NULL at the schema level (confirmed live), and claim_staff_message
  -- additionally rejects a blank/whitespace-only name after trimming
  -- rather than ever storing an invented placeholder — staff_phone stays
  -- nullable since people.phone is legitimately optional.
  person_id                 uuid        NULL REFERENCES public.people(id) ON DELETE SET NULL,
  staff_name                text        NOT NULL,
  staff_phone               text        NULL,

  -- Optional context links.
  task_id                   uuid        NULL REFERENCES public.tasks(id) ON DELETE SET NULL,
  thread_id                 text        NULL,

  -- Transport.
  source                    text        NOT NULL
                                        CHECK (source IN ('simulated', 'internal', 'whatsapp')),
  external_message_id       text        NULL, -- idempotency key, when the transport provides one

  -- Content.
  inbound_text              text        NOT NULL,
  classification            text        NOT NULL DEFAULT 'unclear'
                                        CHECK (classification IN (
                                          'routine_question',
                                          'task_update',
                                          'clarification_request',
                                          'completion_confirmation',
                                          'blocker',
                                          'substitution_request',
                                          'owner_decision_required',
                                          'unclear'
                                        )),
  carson_response            text        NULL,

  -- Internal processing lifecycle — distinct from user_facing_state below.
  -- claimed: row inserted, classification/response not yet produced.
  -- completed: classification/response/escalation outcome recorded.
  -- failed: processing attempt errored; no response was produced or sent.
  processing_status          text        NOT NULL DEFAULT 'claimed'
                                        CHECK (processing_status IN ('claimed', 'completed', 'failed')),
  processing_error           text        NULL,

  -- Operational state (product-facing; set only by complete_staff_message).
  next_action_owner          text        NOT NULL DEFAULT 'carson'
                                        CHECK (next_action_owner IN ('carson', 'staff', 'owner', 'nobody')),
  user_facing_state          text        NOT NULL DEFAULT 'In Progress'
                                        CHECK (user_facing_state IN ('Waiting', 'Needs You', 'Completed', 'In Progress')),
  owner_attention_required   boolean     NOT NULL DEFAULT false,
  escalation_reason          text        NULL, -- the exact decision needed, when escalated

  -- Timestamps.
  received_at                timestamptz NOT NULL,
  responded_at                timestamptz NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: one row per (user_id, source, external_message_id) when the
-- transport supplies one. Simulated/internal test messages typically omit
-- it and are never deduplicated against each other or across sources.
CREATE UNIQUE INDEX IF NOT EXISTS staff_messages_user_source_external_message_id_key
  ON public.staff_messages (user_id, source, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS staff_messages_user_id_received_at_idx
  ON public.staff_messages (user_id, received_at DESC);

CREATE INDEX IF NOT EXISTS staff_messages_person_id_idx
  ON public.staff_messages (person_id)
  WHERE person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS staff_messages_task_id_idx
  ON public.staff_messages (task_id)
  WHERE task_id IS NOT NULL;

-- ── updated_at trigger (same pattern as carson_persistent_memory) ──────────

CREATE OR REPLACE FUNCTION public.set_staff_messages_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_staff_messages_updated_at
BEFORE UPDATE ON public.staff_messages
FOR EACH ROW
EXECUTE FUNCTION public.set_staff_messages_updated_at();

-- ── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE public.staff_messages ENABLE ROW LEVEL SECURITY;

-- Owner-only read. No cross-household visibility: a row's user_id is fixed
-- at claim time by claim_staff_message() after verifying person_id/task_id
-- both belong to that same user_id, so this policy alone is sufficient to
-- prevent one owner from ever seeing another owner's staff messages.
CREATE POLICY "staff_messages: owner can select"
  ON public.staff_messages
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policy for authenticated/anon — staff senders
-- have no Supabase session, so there is nothing for such a policy to grant
-- them anyway. This does NOT stop service_role: service_role bypasses RLS
-- entirely regardless of what policies exist on this table. The guarantee
-- that every write is validated comes from the application layer only ever
-- calling the SECURITY DEFINER functions below, not from Postgres
-- preventing service_role from writing directly.

GRANT SELECT ON public.staff_messages TO authenticated;

-- ── Functions ────────────────────────────────────────────────────────────────

-- Validates the inbound claim (non-null user/person id, supported source,
-- non-empty inbound text, non-null received_at, sender belongs to user_id
-- and is not family, sender has a non-blank canonical name, task — when
-- given — belongs to user_id) and atomically inserts, or, on a duplicate
-- (user_id, source, external_message_id), returns the existing row's
-- id/status unchanged with is_new = false — no second insert, no second
-- side effect for the caller to accidentally trigger.
CREATE OR REPLACE FUNCTION public.claim_staff_message(
  p_user_id             uuid,
  p_person_id           uuid,
  p_task_id             uuid,
  p_thread_id           text,
  p_source              text,
  p_external_message_id text,
  p_inbound_text        text,
  p_received_at         timestamptz
) RETURNS TABLE (message_id uuid, is_new boolean, processing_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_person              public.people;
  v_task                public.tasks;
  v_existing             public.staff_messages;
  v_row                  public.staff_messages;
  v_external_message_id text;
  v_staff_name           text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'missing_user_id' USING ERRCODE = '22023';
  END IF;

  IF p_source IS NULL OR p_source NOT IN ('simulated', 'internal', 'whatsapp') THEN
    RAISE EXCEPTION 'unsupported_source' USING ERRCODE = '22023';
  END IF;

  IF p_inbound_text IS NULL OR btrim(p_inbound_text) = '' THEN
    RAISE EXCEPTION 'empty_inbound_text' USING ERRCODE = '22023';
  END IF;

  IF p_received_at IS NULL THEN
    RAISE EXCEPTION 'missing_received_at' USING ERRCODE = '22023';
  END IF;

  IF p_person_id IS NULL THEN
    RAISE EXCEPTION 'missing_person_id' USING ERRCODE = '22023';
  END IF;

  v_external_message_id := NULLIF(btrim(p_external_message_id), '');

  SELECT * INTO v_person FROM public.people WHERE id = p_person_id;
  IF NOT FOUND OR v_person.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;
  IF v_person.is_family IS TRUE THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '22023';
  END IF;

  -- people.name is NOT NULL at the schema level, but that does not rule out
  -- a blank/whitespace-only value — verify the trimmed canonical name here
  -- and refuse to claim rather than ever storing an invented name.
  v_staff_name := btrim(v_person.name);
  IF v_staff_name IS NULL OR v_staff_name = '' THEN
    RAISE EXCEPTION 'invalid_person_name' USING ERRCODE = '22023';
  END IF;

  IF p_task_id IS NOT NULL THEN
    SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id;
    IF NOT FOUND OR v_task.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
    END IF;
  END IF;

  -- WhatsApp opt-in (people.whatsapp_opted_in) is deliberately NOT checked
  -- here. It only applies to source = 'whatsapp', is meaningless for
  -- simulated/internal test calls, and is enforced in the application-layer
  -- engine before this function is ever called for that source.

  IF v_external_message_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.staff_messages
      WHERE user_id = p_user_id
        AND source = p_source
        AND external_message_id = v_external_message_id;
    IF FOUND THEN
      RETURN QUERY SELECT v_existing.id, false, v_existing.processing_status;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.staff_messages (
    user_id, person_id, staff_name, staff_phone, task_id, thread_id, source,
    external_message_id, inbound_text, received_at
  ) VALUES (
    p_user_id, v_person.id, v_staff_name, v_person.phone, p_task_id, p_thread_id, p_source,
    v_external_message_id, p_inbound_text, p_received_at
  )
  ON CONFLICT (user_id, source, external_message_id) WHERE external_message_id IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN QUERY SELECT v_row.id, true, v_row.processing_status;
    RETURN;
  END IF;

  -- Lost the race to a concurrent claim for the same
  -- (user_id, source, external_message_id).
  SELECT * INTO v_existing FROM public.staff_messages
    WHERE user_id = p_user_id
      AND source = p_source
      AND external_message_id = v_external_message_id;
  RETURN QUERY SELECT v_existing.id, false, v_existing.processing_status;
END;
$$;

-- Finalizes a claimed row with the classification/response/escalation
-- outcome. Only a claimed -> completed transition is allowed: an
-- already-completed row is returned unchanged (idempotent no-op), and any
-- other current state (failed) raises invalid_transition rather than
-- silently overwriting it. Ownership-checked on the row itself.
CREATE OR REPLACE FUNCTION public.complete_staff_message(
  p_id                       uuid,
  p_user_id                  uuid,
  p_classification           text,
  p_carson_response          text,
  p_next_action_owner        text,
  p_user_facing_state        text,
  p_owner_attention_required boolean,
  p_escalation_reason        text,
  p_responded_at             timestamptz
) RETURNS public.staff_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_current public.staff_messages;
  v_row     public.staff_messages;
BEGIN
  SELECT * INTO v_current FROM public.staff_messages
    WHERE id = p_id AND user_id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  IF v_current.processing_status = 'completed' THEN
    RETURN v_current; -- idempotent: already completed, returned unchanged
  END IF;

  IF v_current.processing_status <> 'claimed' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_messages SET
    classification = p_classification,
    carson_response = p_carson_response,
    next_action_owner = p_next_action_owner,
    user_facing_state = p_user_facing_state,
    owner_attention_required = p_owner_attention_required,
    escalation_reason = p_escalation_reason,
    responded_at = p_responded_at,
    processing_status = 'completed'
  WHERE id = p_id AND user_id = p_user_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- Guarded claimed -> failed transition, for when classification/response
-- generation errors out before producing a result. Only a claimed ->
-- failed transition is allowed: an already-failed row is returned
-- unchanged (idempotent no-op), and completed -> failed is rejected with
-- invalid_transition — a completed outcome can never be retroactively
-- marked as failed.
CREATE OR REPLACE FUNCTION public.fail_staff_message(
  p_id               uuid,
  p_user_id          uuid,
  p_processing_error text
) RETURNS public.staff_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_current           public.staff_messages;
  v_row               public.staff_messages;
  v_processing_error  text;
BEGIN
  v_processing_error := btrim(p_processing_error);
  IF v_processing_error IS NULL OR v_processing_error = '' THEN
    RAISE EXCEPTION 'empty_processing_error' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_current FROM public.staff_messages
    WHERE id = p_id AND user_id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  IF v_current.processing_status = 'failed' THEN
    RETURN v_current; -- idempotent: already failed, returned unchanged
  END IF;

  IF v_current.processing_status <> 'claimed' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_messages SET
    processing_status = 'failed',
    processing_error = v_processing_error
  WHERE id = p_id AND user_id = p_user_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- Guarded failed -> claimed transition: explicit server-side recovery only.
-- Never invoked automatically by claim_staff_message on a duplicate inbound
-- delivery — a duplicate always returns the existing row as-is, whatever
-- its current processing_status, and a caller must call this function
-- separately and deliberately to retry a failed message.
--
-- Return contract (message_id, is_retried, processing_status):
--   failed -> claimed (this call performed the reclaim): message_id, TRUE, 'claimed'.
--   already claimed (no-op — e.g. a concurrent retry got there first):
--     message_id, FALSE, 'claimed'.
--   completed: rejected with invalid_transition — never returned as a row.
-- Only is_retried = true means THIS call performed the failed -> claimed
-- transition. The caller MUST gate all further work — restarting
-- classification, generating a response, or any other side effect — on
-- is_retried = true. A caller that receives is_retried = false must stop
-- and must not process the message; a false result never implies the
-- caller now owns the message.
--
-- Fields reset on a genuine reclaim: processing_status ('failed' ->
-- 'claimed') and processing_error (cleared to NULL) only.
--
-- Fields preserved untouched: inbound_text, staff_name, staff_phone,
-- person_id, task_id, thread_id, source, external_message_id, received_at,
-- classification, carson_response, next_action_owner, user_facing_state,
-- owner_attention_required, escalation_reason, responded_at. None of these
-- need to be re-derived or re-verified on retry: the identity/ownership
-- checks already passed atomically inside the original claim_staff_message
-- call, and the row's existence under this user_id is itself sufficient
-- proof of that; a failed row, by construction, never reached
-- complete_staff_message, so classification/carson_response/
-- next_action_owner/user_facing_state/owner_attention_required/
-- escalation_reason/responded_at are still at their untouched claim-time
-- defaults and will be written correctly by complete_staff_message after a
-- successful retry.
CREATE OR REPLACE FUNCTION public.retry_staff_message(
  p_id      uuid,
  p_user_id uuid
) RETURNS TABLE (message_id uuid, is_retried boolean, processing_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_current public.staff_messages;
  v_row     public.staff_messages;
BEGIN
  SELECT * INTO v_current FROM public.staff_messages
    WHERE id = p_id AND user_id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '28000';
  END IF;

  -- Safe, intentional no-op: a concurrent retry that already flipped this
  -- row to 'claimed' means the recovery already happened. is_retried =
  -- false tells the caller it did NOT perform the reclaim — it must not
  -- restart classification or produce any side effect.
  IF v_current.processing_status = 'claimed' THEN
    RETURN QUERY SELECT v_current.id, false, v_current.processing_status;
    RETURN;
  END IF;

  IF v_current.processing_status <> 'failed' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_messages SET
    processing_status = 'claimed',
    processing_error = NULL
  WHERE id = p_id AND user_id = p_user_id
  RETURNING * INTO v_row;

  RETURN QUERY SELECT v_row.id, true, v_row.processing_status;
END;
$$;

-- ── Execute grants: service_role only ───────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.claim_staff_message(uuid, uuid, uuid, text, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_staff_message(uuid, uuid, text, text, text, text, boolean, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_staff_message(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.retry_staff_message(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_staff_message(uuid, uuid, uuid, text, text, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_staff_message(uuid, uuid, text, text, text, text, boolean, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_staff_message(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_staff_message(uuid, uuid) TO service_role;
