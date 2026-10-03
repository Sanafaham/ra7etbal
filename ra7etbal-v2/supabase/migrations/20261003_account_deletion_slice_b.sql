-- Phase 3F / Slice B: inventory and neutralize pre-existing consequential work.
-- Additive only. External cancellation is performed by the existing scheduler;
-- this migration never calls a provider and never deletes user data.

CREATE TABLE public.account_deletion_work_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.account_deletion_requests(id) ON DELETE CASCADE,
  work_kind text NOT NULL CHECK (work_kind IN (
    'qstash_reminder', 'pending_task', 'automation', 'automation_run', 'pending_operation'
  )),
  work_id text NOT NULL,
  provider text CHECK (provider IS NULL OR provider IN ('qstash')),
  provider_work_id text,
  status text NOT NULL CHECK (status IN (
    'locally_invalidated', 'external_cancellation_pending', 'external_cancellation_attempted',
    'external_cancellation_confirmed', 'external_outcome_unknown',
    'failed_retryable', 'failed_requires_review'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,80}$'),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz,
  confirmed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, work_kind, work_id),
  CHECK ((status = 'external_cancellation_confirmed') = (confirmed_at IS NOT NULL)),
  CHECK (
    (provider = 'qstash' AND provider_work_id IS NOT NULL)
    OR (provider IS NULL AND provider_work_id IS NULL)
  )
);

CREATE INDEX account_deletion_work_cancellations_retry_idx
  ON public.account_deletion_work_cancellations (next_attempt_at, lease_expires_at)
  WHERE status IN ('external_cancellation_pending', 'external_outcome_unknown', 'failed_retryable');

ALTER TABLE public.account_deletion_work_cancellations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "account deletion cancellations: owner can read"
  ON public.account_deletion_work_cancellations
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.account_deletion_requests r
    WHERE r.id = request_id AND r.user_id = auth.uid()
  ));

REVOKE ALL ON public.account_deletion_work_cancellations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_deletion_work_cancellations TO authenticated;
GRANT ALL ON public.account_deletion_work_cancellations TO service_role;

CREATE OR REPLACE FUNCTION public.inventory_account_deletion_inflight_work()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- The deletion request itself is the durable local tombstone. Runtime
  -- execution boundaries continue to consult it even if external cancellation
  -- times out. Evidence rows contain identifiers only, never message content.
  INSERT INTO public.account_deletion_work_cancellations
    (request_id, work_kind, work_id, provider, provider_work_id, status, next_attempt_at)
  SELECT NEW.id, 'qstash_reminder', t.id::text, 'qstash', t.qstash_message_id,
         'external_cancellation_pending', now()
  FROM public.tasks t
  WHERE t.user_id = NEW.user_id
    AND t.status = 'pending'
    AND t.qstash_message_id IS NOT NULL
  ON CONFLICT (request_id, work_kind, work_id) DO NOTHING;

  INSERT INTO public.account_deletion_work_cancellations
    (request_id, work_kind, work_id, status)
  SELECT NEW.id, 'pending_task', t.id::text, 'locally_invalidated'
  FROM public.tasks t
  WHERE t.user_id = NEW.user_id
    AND t.status = 'pending'
    AND t.type IN ('delegation', 'followup', 'reminder')
  ON CONFLICT (request_id, work_kind, work_id) DO NOTHING;

  INSERT INTO public.account_deletion_work_cancellations
    (request_id, work_kind, work_id, status)
  SELECT NEW.id, 'automation', a.id::text, 'locally_invalidated'
  FROM public.automations a
  WHERE a.user_id = NEW.user_id AND a.status = 'active'
  ON CONFLICT (request_id, work_kind, work_id) DO NOTHING;

  INSERT INTO public.account_deletion_work_cancellations
    (request_id, work_kind, work_id, status)
  SELECT NEW.id, 'automation_run', ar.id::text, 'locally_invalidated'
  FROM public.automation_runs ar
  WHERE ar.user_id = NEW.user_id AND ar.current_state IN ('scheduled', 'task_created')
  ON CONFLICT (request_id, work_kind, work_id) DO NOTHING;

  INSERT INTO public.account_deletion_work_cancellations
    (request_id, work_kind, work_id, status)
  SELECT NEW.id, 'pending_operation', p.id::text, 'locally_invalidated'
  FROM public.carson_pending_operations p
  WHERE p.user_id = NEW.user_id AND p.status = 'pending'
  ON CONFLICT (request_id, work_kind, work_id) DO NOTHING;

  UPDATE public.carson_pending_operations
  SET status = 'cancelled'
  WHERE user_id = NEW.user_id AND status = 'pending';

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_account_deletion_inflight_work() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER inventory_account_deletion_inflight_work
AFTER INSERT OR UPDATE OF freeze_started_at ON public.account_deletion_requests
FOR EACH ROW EXECUTE FUNCTION public.inventory_account_deletion_inflight_work();

-- Slice A may already have a frozen request when this additive migration is
-- rolled out. Replaying the idempotent inventory closes that rollout gap.
UPDATE public.account_deletion_requests
SET freeze_started_at = freeze_started_at
WHERE status IN ('in_progress', 'failed_retryable', 'failed_requires_review');

CREATE OR REPLACE FUNCTION public.claim_account_deletion_cancellation(p_lease_seconds integer DEFAULT 60)
RETURNS SETOF public.account_deletion_work_cancellations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_token uuid := gen_random_uuid();
BEGIN
  SELECT c.id INTO v_id
  FROM public.account_deletion_work_cancellations c
  JOIN public.account_deletion_requests r ON r.id = c.request_id
  WHERE c.provider = 'qstash'
    AND c.status IN (
      'external_cancellation_pending', 'external_cancellation_attempted',
      'external_outcome_unknown', 'failed_retryable'
    )
    AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
    AND (c.lease_expires_at IS NULL OR c.lease_expires_at <= now())
    AND r.status IN ('in_progress', 'failed_retryable', 'failed_requires_review')
  ORDER BY c.discovered_at, c.id
  FOR UPDATE OF c SKIP LOCKED
  LIMIT 1;

  IF v_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.account_deletion_work_cancellations c
  SET status = 'external_cancellation_attempted',
      attempt_count = c.attempt_count + 1,
      last_attempted_at = now(),
      lease_token = v_token,
      lease_expires_at = now() + make_interval(secs => greatest(15, least(p_lease_seconds, 300))),
      updated_at = now()
  WHERE c.id = v_id
  RETURNING c.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_account_deletion_cancellation(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_account_deletion_cancellation(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_account_deletion_cancellation(
  p_id uuid, p_lease_token uuid, p_outcome text, p_failure_code text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_updated integer;
BEGIN
  IF p_outcome NOT IN ('external_cancellation_confirmed', 'external_outcome_unknown', 'failed_retryable', 'failed_requires_review') THEN
    RAISE EXCEPTION 'invalid_cancellation_outcome' USING ERRCODE = '22023';
  END IF;
  IF p_failure_code IS NOT NULL AND p_failure_code !~ '^[a-z0-9_]{1,80}$' THEN
    RAISE EXCEPTION 'invalid_failure_code' USING ERRCODE = '22023';
  END IF;

  UPDATE public.account_deletion_work_cancellations
  SET status = p_outcome,
      failure_code = p_failure_code,
      confirmed_at = CASE WHEN p_outcome = 'external_cancellation_confirmed' THEN now() ELSE NULL END,
      next_attempt_at = CASE
        WHEN p_outcome IN ('external_outcome_unknown', 'failed_retryable') THEN now() + interval '10 minutes'
        ELSE NULL
      END,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = p_id
    AND lease_token = p_lease_token
    AND status = 'external_cancellation_attempted';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_account_deletion_cancellation(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_account_deletion_cancellation(uuid, uuid, text, text) TO service_role;
