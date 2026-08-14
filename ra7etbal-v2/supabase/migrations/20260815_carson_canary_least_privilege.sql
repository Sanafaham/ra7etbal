/**
 * Carson production canary — least-privilege read interface.
 *
 * GitHub Actions must never receive SUPABASE_SERVICE_ROLE_KEY. This
 * migration exposes one bounded, read-only aggregate through PostgREST.
 * The caller supplies a high-entropy canary token; only its SHA-256 digest
 * is stored in the database. The function returns no user rows or business
 * content, only the two health verdicts and their violation counts.
 */

CREATE SCHEMA carson_canary_private;
REVOKE ALL ON SCHEMA carson_canary_private FROM PUBLIC, anon, authenticated;

CREATE TABLE carson_canary_private.config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  token_sha256 bytea NOT NULL CHECK (octet_length(token_sha256) = 32),
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE carson_canary_private.config FROM PUBLIC, anon, authenticated, service_role;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'carson_canary_function_owner') THEN
    CREATE ROLE carson_canary_function_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_roles
     WHERE rolname = 'carson_canary_function_owner'
       AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR
            rolinherit OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'carson_canary_function_owner has unsafe role attributes';
  END IF;
END
$roles$;

GRANT USAGE ON SCHEMA carson_canary_private, public TO carson_canary_function_owner;
GRANT SELECT (singleton, token_sha256) ON carson_canary_private.config TO carson_canary_function_owner;
GRANT SELECT (phone_number_id) ON public.whatsapp_health_state TO carson_canary_function_owner;
GRANT SELECT (id, person_id, automation_run_id, created_at) ON public.whatsapp_deliveries TO carson_canary_function_owner;
GRANT SELECT (id, automation_id) ON public.automation_runs TO carson_canary_function_owner;
GRANT SELECT (id, assignee_id) ON public.automations TO carson_canary_function_owner;

CREATE POLICY "whatsapp_health_state: canary aggregate select"
  ON public.whatsapp_health_state FOR SELECT
  TO carson_canary_function_owner USING (true);
CREATE POLICY "whatsapp_deliveries: canary aggregate select"
  ON public.whatsapp_deliveries FOR SELECT
  TO carson_canary_function_owner USING (true);
CREATE POLICY "automation_runs: canary aggregate select"
  ON public.automation_runs FOR SELECT
  TO carson_canary_function_owner USING (true);
CREATE POLICY "automations: canary aggregate select"
  ON public.automations FOR SELECT
  TO carson_canary_function_owner USING (true);

-- A function owner needs CREATE briefly to receive ownership. Remove it
-- immediately afterward so the NOLOGIN owner cannot create other objects.
GRANT CREATE ON SCHEMA public TO carson_canary_function_owner;
-- Supabase's managed `postgres` role is intentionally not a superuser and
-- therefore needs temporary membership to transfer function ownership.
-- Remove the membership immediately after the transfer.
GRANT carson_canary_function_owner TO postgres;

CREATE OR REPLACE FUNCTION public.carson_production_canary_health(p_token text)
RETURNS TABLE (
  canonical_binding_healthy boolean,
  ambiguous_binding_count bigint,
  person_id_continuity_healthy boolean,
  violating_row_count bigint,
  checked_since timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '5s'
AS $function$
DECLARE
  v_expected_hash bytea;
  v_ambiguous_count bigint;
  v_violating_count bigint;
  v_checked_since timestamptz := statement_timestamp() - interval '30 days';
BEGIN
  -- Bound attacker-controlled work and fail before touching production
  -- tables. Missing configuration and bad credentials are indistinguishable.
  IF p_token IS NULL OR octet_length(p_token) < 32 OR octet_length(p_token) > 256 THEN
    RAISE EXCEPTION 'canary authentication failed' USING ERRCODE = '28000';
  END IF;

  SELECT c.token_sha256
    INTO v_expected_hash
    FROM carson_canary_private.config AS c
   WHERE c.singleton = true;

  IF v_expected_hash IS NULL
     OR v_expected_hash <> pg_catalog.sha256(convert_to(p_token, 'UTF8')) THEN
    RAISE EXCEPTION 'canary authentication failed' USING ERRCODE = '28000';
  END IF;

  SELECT count(*)
    INTO v_ambiguous_count
    FROM (
      SELECT h.phone_number_id
        FROM public.whatsapp_health_state AS h
       GROUP BY h.phone_number_id
      HAVING count(*) > 1
    ) AS ambiguous_bindings;

  SELECT count(*)
    INTO v_violating_count
    FROM public.whatsapp_deliveries AS d
    JOIN public.automation_runs AS r ON r.id = d.automation_run_id
    JOIN public.automations AS a ON a.id = r.automation_id
   WHERE d.person_id IS NULL
     AND d.automation_run_id IS NOT NULL
     AND d.created_at > v_checked_since
     AND a.assignee_id IS NOT NULL;

  RETURN QUERY SELECT
    v_ambiguous_count = 0,
    v_ambiguous_count,
    v_violating_count = 0,
    v_violating_count,
    v_checked_since;
END
$function$;

ALTER FUNCTION public.carson_production_canary_health(text)
  OWNER TO carson_canary_function_owner;
REVOKE CREATE ON SCHEMA public FROM carson_canary_function_owner;

REVOKE ALL ON FUNCTION public.carson_production_canary_health(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.carson_production_canary_health(text) TO anon;

COMMENT ON FUNCTION public.carson_production_canary_health(text) IS
  'Token-gated, read-only aggregate health for the out-of-band Carson production canary. Returns no raw production rows.';
REVOKE carson_canary_function_owner FROM postgres;
