-- AI Consent Slice 1: inactive, append-only authority foundation.
-- ACL-safe reapplication artifact after the original Production application
-- (20261004200228) was boundedly rolled back (20261004200347).
-- This migration does not gate or authorize any provider call by itself.

CREATE TABLE public.ai_consent_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('grant', 'withdraw', 'supersede')),
  target_grant_id uuid REFERENCES public.ai_consent_events(id),
  contract_version text NOT NULL CHECK (contract_version ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  disclosure_version text NOT NULL CHECK (disclosure_version ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  provider_scope_kind text NOT NULL CHECK (provider_scope_kind IN ('provider', 'provider_category')),
  provider_scope text NOT NULL CHECK (provider_scope ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  data_categories text[] NOT NULL,
  source_surface text NOT NULL CHECK (source_surface ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  input_mode text NOT NULL CHECK (input_mode IN ('text', 'voice', 'whatsapp', 'audio_upload', 'mixed', 'system', 'not_applicable')),
  affirmative_action text CHECK (affirmative_action ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('authenticated_user', 'service')),
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(data_categories) BETWEEN 1 AND 32),
  CHECK (
    (event_type = 'grant' AND target_grant_id IS NULL AND affirmative_action IS NOT NULL)
    OR (event_type IN ('withdraw', 'supersede') AND target_grant_id IS NOT NULL AND affirmative_action IS NULL)
  ),
  CHECK (
    (event_type IN ('grant', 'withdraw') AND actor_kind = 'authenticated_user' AND actor_user_id = user_id)
    OR (event_type = 'supersede' AND actor_kind = 'service' AND actor_user_id IS NULL)
  )
);

CREATE INDEX ai_consent_events_user_occurred_idx
  ON public.ai_consent_events (user_id, occurred_at DESC, id);
CREATE INDEX ai_consent_events_target_idx
  ON public.ai_consent_events (target_grant_id)
  WHERE target_grant_id IS NOT NULL;

ALTER TABLE public.ai_consent_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai consent: owner can read evidence"
  ON public.ai_consent_events
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Existing Supabase projects may grant broad table privileges through the
-- creator's default ACL. GRANT never narrows those inherited privileges, so
-- normalize every client/service role before restoring the exact minimum.
REVOKE ALL ON public.ai_consent_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ai_consent_events TO authenticated;
GRANT SELECT, INSERT ON public.ai_consent_events TO service_role;

CREATE OR REPLACE FUNCTION public.reject_ai_consent_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'ai_consent_events_are_immutable' USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_ai_consent_event_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reject_ai_consent_event_mutation
BEFORE UPDATE OR DELETE ON public.ai_consent_events
FOR EACH ROW EXECUTE FUNCTION public.reject_ai_consent_event_mutation();

CREATE OR REPLACE FUNCTION public.grant_ai_consent(
  p_event_id uuid,
  p_contract_version text,
  p_disclosure_version text,
  p_purpose text,
  p_provider_scope_kind text,
  p_provider_scope text,
  p_data_categories text[],
  p_source_surface text,
  p_input_mode text,
  p_affirmative_action text
) RETURNS public.ai_consent_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_categories text[];
  v_result public.ai_consent_events;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
  END IF;
  IF p_event_id IS NULL OR p_contract_version !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
     OR p_disclosure_version !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
     OR p_purpose !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
     OR p_provider_scope_kind NOT IN ('provider', 'provider_category')
     OR p_provider_scope !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
     OR p_source_surface !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
     OR p_input_mode NOT IN ('text', 'voice', 'whatsapp', 'audio_upload', 'mixed', 'system', 'not_applicable')
     OR p_affirmative_action !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
  THEN
    RAISE EXCEPTION 'invalid_ai_consent_grant' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT category ORDER BY category) INTO v_categories
  FROM unnest(p_data_categories) AS category
  WHERE category ~ '^[a-z0-9][a-z0-9._-]{0,79}$';
  IF v_categories IS NULL OR cardinality(v_categories) <> cardinality(p_data_categories)
     OR cardinality(v_categories) > 32 THEN
    RAISE EXCEPTION 'invalid_ai_consent_categories' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ai_consent_events (
    id, user_id, event_type, contract_version, disclosure_version, purpose,
    provider_scope_kind, provider_scope, data_categories, source_surface,
    input_mode, affirmative_action, actor_kind, actor_user_id
  ) VALUES (
    p_event_id, v_user_id, 'grant', p_contract_version, p_disclosure_version,
    p_purpose, p_provider_scope_kind, p_provider_scope, v_categories,
    p_source_surface, p_input_mode, p_affirmative_action, 'authenticated_user', v_user_id
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_result;

  IF NOT FOUND THEN
    SELECT * INTO v_result FROM public.ai_consent_events WHERE id = p_event_id;
    IF v_result.user_id IS DISTINCT FROM v_user_id
       OR v_result.event_type <> 'grant'
       OR v_result.contract_version <> p_contract_version
       OR v_result.disclosure_version <> p_disclosure_version
       OR v_result.purpose <> p_purpose
       OR v_result.provider_scope_kind <> p_provider_scope_kind
       OR v_result.provider_scope <> p_provider_scope
       OR v_result.data_categories <> v_categories
       OR v_result.source_surface <> p_source_surface
       OR v_result.input_mode <> p_input_mode
       OR v_result.affirmative_action <> p_affirmative_action THEN
      RAISE EXCEPTION 'ai_consent_event_conflict' USING ERRCODE = '23000';
    END IF;
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_ai_consent(p_event_id uuid, p_grant_id uuid)
RETURNS public.ai_consent_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_grant public.ai_consent_events;
  v_result public.ai_consent_events;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_grant FROM public.ai_consent_events
   WHERE id = p_grant_id AND user_id = v_user_id AND event_type = 'grant';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_consent_grant_not_found' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.ai_consent_events (
    id, user_id, event_type, target_grant_id, contract_version,
    disclosure_version, purpose, provider_scope_kind, provider_scope,
    data_categories, source_surface, input_mode, actor_kind, actor_user_id
  ) VALUES (
    p_event_id, v_user_id, 'withdraw', v_grant.id, v_grant.contract_version,
    v_grant.disclosure_version, v_grant.purpose, v_grant.provider_scope_kind,
    v_grant.provider_scope, v_grant.data_categories, 'owner_withdrawal',
    v_grant.input_mode, 'authenticated_user', v_user_id
  )
  ON CONFLICT (id) DO NOTHING RETURNING * INTO v_result;

  IF NOT FOUND THEN
    SELECT * INTO v_result FROM public.ai_consent_events WHERE id = p_event_id;
    IF v_result.user_id IS DISTINCT FROM v_user_id
       OR v_result.event_type <> 'withdraw'
       OR v_result.target_grant_id IS DISTINCT FROM p_grant_id THEN
      RAISE EXCEPTION 'ai_consent_event_conflict' USING ERRCODE = '23000';
    END IF;
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.supersede_ai_consent(
  p_event_id uuid, p_user_id uuid, p_grant_id uuid, p_source_surface text
) RETURNS public.ai_consent_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_grant public.ai_consent_events;
  v_result public.ai_consent_events;
BEGIN
  IF p_source_surface !~ '^[a-z0-9][a-z0-9._-]{0,79}$' THEN
    RAISE EXCEPTION 'invalid_ai_consent_supersession' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_grant FROM public.ai_consent_events
   WHERE id = p_grant_id AND user_id = p_user_id AND event_type = 'grant';
  IF NOT FOUND THEN RAISE EXCEPTION 'ai_consent_grant_not_found' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.ai_consent_events (
    id, user_id, event_type, target_grant_id, contract_version,
    disclosure_version, purpose, provider_scope_kind, provider_scope,
    data_categories, source_surface, input_mode, actor_kind, actor_user_id
  ) VALUES (
    p_event_id, p_user_id, 'supersede', v_grant.id, v_grant.contract_version,
    v_grant.disclosure_version, v_grant.purpose, v_grant.provider_scope_kind,
    v_grant.provider_scope, v_grant.data_categories, p_source_surface,
    v_grant.input_mode, 'service', NULL
  )
  ON CONFLICT (id) DO NOTHING RETURNING * INTO v_result;
  IF NOT FOUND THEN
    SELECT * INTO v_result FROM public.ai_consent_events WHERE id = p_event_id;
    IF v_result.user_id IS DISTINCT FROM p_user_id OR v_result.event_type <> 'supersede'
       OR v_result.target_grant_id IS DISTINCT FROM p_grant_id THEN
      RAISE EXCEPTION 'ai_consent_event_conflict' USING ERRCODE = '23000';
    END IF;
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.evaluate_ai_consent_authority(
  p_user_id uuid,
  p_contract_version text,
  p_provider text,
  p_provider_category text,
  p_purpose text,
  p_required_data_categories text[]
) RETURNS TABLE (authorized boolean, reason text, grant_event_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_grant_id uuid;
  v_required_categories text[];
BEGIN
  IF p_user_id IS NULL OR p_contract_version !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
     OR p_provider !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
     OR p_provider_category !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
     OR p_purpose !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
     OR cardinality(p_required_data_categories) NOT BETWEEN 1 AND 32 THEN
    RETURN QUERY SELECT false, 'malformed_requirement'::text, NULL::uuid; RETURN;
  END IF;

  SELECT array_agg(DISTINCT category ORDER BY category) INTO v_required_categories
  FROM unnest(p_required_data_categories) AS category
  WHERE category ~ '^[a-z0-9][a-z0-9._-]{0,79}$';
  IF v_required_categories IS NULL
     OR cardinality(v_required_categories) <> cardinality(p_required_data_categories) THEN
    RETURN QUERY SELECT false, 'malformed_requirement'::text, NULL::uuid; RETURN;
  END IF;

  SELECT g.id INTO v_grant_id
  FROM public.ai_consent_events g
  WHERE g.user_id = p_user_id AND g.event_type = 'grant'
    AND g.contract_version = p_contract_version AND g.purpose = p_purpose
    AND ((g.provider_scope_kind = 'provider' AND g.provider_scope = p_provider)
      OR (g.provider_scope_kind = 'provider_category' AND g.provider_scope = p_provider_category))
    AND g.data_categories @> v_required_categories
    AND NOT EXISTS (SELECT 1 FROM public.ai_consent_events x
      WHERE x.target_grant_id = g.id AND x.event_type IN ('withdraw', 'supersede'))
  ORDER BY g.occurred_at DESC, g.id DESC LIMIT 1;

  IF v_grant_id IS NOT NULL THEN
    RETURN QUERY SELECT true, 'authorized'::text, v_grant_id; RETURN;
  END IF;
  RETURN QUERY SELECT false, 'no_current_authority'::text, NULL::uuid;
END;
$$;

-- Function defaults are normalized for the same reason: PUBLIC and every
-- application role lose inherited EXECUTE before exact RPC grants return.
REVOKE ALL ON FUNCTION public.grant_ai_consent(uuid, text, text, text, text, text, text[], text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.withdraw_ai_consent(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.supersede_ai_consent(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.evaluate_ai_consent_authority(uuid, text, text, text, text, text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.grant_ai_consent(uuid, text, text, text, text, text, text[], text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_ai_consent(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_ai_consent(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_ai_consent_authority(uuid, text, text, text, text, text[]) TO service_role;
