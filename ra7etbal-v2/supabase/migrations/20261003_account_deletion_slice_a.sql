-- Phase 3E / Slice A: durable deletion request + fail-closed consequential freeze.
-- This migration never deletes account data or auth identities.

CREATE TABLE public.account_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'failed_retryable', 'failed_requires_review', 'completed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  freeze_started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failure_code text,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK (status = 'completed' OR user_id IS NOT NULL),
  CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,80}$')
);

CREATE UNIQUE INDEX account_deletion_requests_one_active_per_user
  ON public.account_deletion_requests (user_id)
  WHERE status <> 'completed';

ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "account deletion: owner can read"
  ON public.account_deletion_requests
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.account_deletion_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_deletion_requests TO authenticated;
GRANT ALL ON public.account_deletion_requests TO service_role;

-- Minimal append-only transition evidence survives final auth identity removal.
-- It deliberately contains no user content or provider payloads.
CREATE TABLE public.account_deletion_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.account_deletion_requests(id) ON DELETE CASCADE,
  status text NOT NULL
    CHECK (status IN ('in_progress', 'failed_retryable', 'failed_requires_review', 'completed')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  failure_code text,
  CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,80}$')
);

ALTER TABLE public.account_deletion_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "account deletion events: owner can read"
  ON public.account_deletion_events
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.account_deletion_requests r
    WHERE r.id = request_id AND r.user_id = auth.uid()
  ));

REVOKE ALL ON public.account_deletion_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_deletion_events TO authenticated;
GRANT ALL ON public.account_deletion_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_account_deletion_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.account_deletion_events (request_id, status, failure_code)
    VALUES (NEW.id, NEW.status, NEW.failure_code);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.record_account_deletion_transition() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER record_account_deletion_transition
AFTER INSERT OR UPDATE OF status ON public.account_deletion_requests
FOR EACH ROW EXECUTE FUNCTION public.record_account_deletion_transition();

CREATE OR REPLACE FUNCTION public.account_deletion_is_frozen(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.account_deletion_requests r
    WHERE r.user_id = p_user_id
      AND r.status IN ('in_progress', 'failed_retryable', 'failed_requires_review')
  );
$$;

REVOKE ALL ON FUNCTION public.account_deletion_is_frozen(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_is_frozen(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.request_account_deletion()
RETURNS public.account_deletion_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_text text := auth.jwt() ->> 'session_id';
  v_session_id uuid;
  v_request public.account_deletion_requests;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
  END IF;

  IF v_session_text IS NULL OR v_session_text !~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  THEN
    RAISE EXCEPTION 'recent_authentication_required' USING ERRCODE = '42501';
  END IF;
  v_session_id := v_session_text::uuid;

  -- Refreshing a JWT does not refresh auth.sessions.created_at. This proves
  -- that the underlying login session itself was created recently.
  IF NOT EXISTS (
    SELECT 1
    FROM auth.sessions s
    WHERE s.id = v_session_id
      AND s.user_id = v_user_id
      AND s.created_at >= now() - interval '15 minutes'
      AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN
    RAISE EXCEPTION 'recent_authentication_required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_request
  FROM public.account_deletion_requests r
  WHERE r.user_id = v_user_id AND r.status <> 'completed'
  FOR UPDATE;

  IF FOUND THEN
    RETURN v_request;
  END IF;

  BEGIN
    INSERT INTO public.account_deletion_requests (user_id)
    VALUES (v_user_id)
    RETURNING * INTO v_request;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_request
    FROM public.account_deletion_requests r
    WHERE r.user_id = v_user_id AND r.status <> 'completed';
  END;

  RETURN v_request;
END;
$$;

REVOKE ALL ON FUNCTION public.request_account_deletion() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_account_deletion() TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_frozen_account_consequential_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := NEW.user_id;
BEGIN
  IF public.account_deletion_is_frozen(v_user_id) THEN
    RAISE EXCEPTION 'account_deletion_in_progress' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_frozen_account_consequential_insert() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER reject_frozen_account_task_insert
BEFORE INSERT ON public.tasks
FOR EACH ROW
WHEN (NEW.type IN ('delegation', 'followup', 'reminder'))
EXECUTE FUNCTION public.reject_frozen_account_consequential_insert();

CREATE TRIGGER reject_frozen_account_message_insert
BEFORE INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.reject_frozen_account_consequential_insert();

CREATE TRIGGER reject_frozen_account_automation_insert
BEFORE INSERT ON public.automations
FOR EACH ROW
EXECUTE FUNCTION public.reject_frozen_account_consequential_insert();

CREATE TRIGGER reject_frozen_account_routine_insert
BEFORE INSERT ON public.routines
FOR EACH ROW
EXECUTE FUNCTION public.reject_frozen_account_consequential_insert();
