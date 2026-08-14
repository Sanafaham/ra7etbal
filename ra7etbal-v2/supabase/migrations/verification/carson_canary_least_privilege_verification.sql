\set ON_ERROR_STOP on

-- CI-only credential. Production configuration is a separate manual step;
-- the plaintext token is never stored by the migration.
INSERT INTO carson_canary_private.config (singleton, token_sha256)
VALUES (true, pg_catalog.sha256(convert_to('ci-only-carson-canary-token-0001', 'UTF8')))
ON CONFLICT (singleton) DO UPDATE SET token_sha256 = EXCLUDED.token_sha256;

DO $verify_permissions$
DECLARE
  v_owner_oid oid;
  v_config text[];
  v_source text;
BEGIN
  SELECT oid INTO v_owner_oid FROM pg_roles WHERE rolname = 'carson_canary_function_owner';
  IF v_owner_oid IS NULL THEN RAISE EXCEPTION 'FAIL: function owner role missing'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE oid = v_owner_oid
       AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'FAIL: function owner has privilege-bearing role attributes';
  END IF;

  IF has_schema_privilege('carson_canary_function_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'FAIL: function owner retained CREATE on public';
  END IF;

  IF pg_has_role('postgres', 'carson_canary_function_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'FAIL: postgres retains canary function owner membership';
  END IF;

  IF has_table_privilege('carson_canary_function_owner', 'public.whatsapp_health_state', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('carson_canary_function_owner', 'public.whatsapp_deliveries', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('carson_canary_function_owner', 'public.automation_runs', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('carson_canary_function_owner', 'public.automations', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('carson_canary_function_owner', 'carson_canary_private.config', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'FAIL: function owner has mutation privileges';
  END IF;

  IF NOT has_column_privilege('carson_canary_function_owner', 'public.whatsapp_health_state', 'phone_number_id', 'SELECT')
     OR NOT has_column_privilege('carson_canary_function_owner', 'public.whatsapp_deliveries', 'person_id', 'SELECT')
     OR NOT has_column_privilege('carson_canary_function_owner', 'public.whatsapp_deliveries', 'automation_run_id', 'SELECT')
     OR NOT has_column_privilege('carson_canary_function_owner', 'public.whatsapp_deliveries', 'created_at', 'SELECT')
     OR NOT has_column_privilege('carson_canary_function_owner', 'public.automation_runs', 'id', 'SELECT')
     OR NOT has_column_privilege('carson_canary_function_owner', 'public.automation_runs', 'automation_id', 'SELECT')
     OR NOT has_column_privilege('carson_canary_function_owner', 'public.automations', 'id', 'SELECT')
     OR NOT has_column_privilege('carson_canary_function_owner', 'public.automations', 'assignee_id', 'SELECT')
     OR NOT has_column_privilege('carson_canary_function_owner', 'carson_canary_private.config', 'singleton', 'SELECT')
     OR NOT has_column_privilege('carson_canary_function_owner', 'carson_canary_private.config', 'token_sha256', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: function owner is missing a required column-level SELECT';
  END IF;

  IF has_function_privilege('public', 'public.carson_production_canary_health(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.carson_production_canary_health(text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.carson_production_canary_health(text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.carson_production_canary_health(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: RPC EXECUTE grants are not anon-only';
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname LIKE '%: canary aggregate select'
         AND roles = ARRAY['carson_canary_function_owner']::name[]
         AND cmd = 'SELECT'
         AND qual = 'true') <> 4 THEN
    RAISE EXCEPTION 'FAIL: expected exactly four canary-owner SELECT-only RLS policies';
  END IF;

  SELECT p.proconfig, p.prosrc INTO v_config, v_source
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'carson_production_canary_health';

  IF NOT ('search_path=pg_catalog' = ANY(v_config))
     OR NOT ('statement_timeout=5s' = ANY(v_config)) THEN
    RAISE EXCEPTION 'FAIL: RPC safe search_path/timeout configuration missing: %', v_config;
  END IF;

  IF v_source ~* '\m(execute|insert|update|delete|merge|truncate|alter|create|drop|grant|revoke)\M' THEN
    RAISE EXCEPTION 'FAIL: RPC source contains dynamic SQL or mutation DDL/DML';
  END IF;
END
$verify_permissions$;

DO $bad_token$
BEGIN
  PERFORM * FROM public.carson_production_canary_health('wrong-token-that-is-long-enough-000000');
  RAISE EXCEPTION 'FAIL: incorrect token was accepted';
EXCEPTION WHEN invalid_authorization_specification THEN
  NULL;
END
$bad_token$;

-- A healthy empty fixture produces one bounded aggregate row.
SET ROLE anon;
DO $healthy$
DECLARE v record;
BEGIN
  SELECT * INTO v
    FROM public.carson_production_canary_health('ci-only-carson-canary-token-0001');
  IF v.canonical_binding_healthy IS DISTINCT FROM true OR v.ambiguous_binding_count <> 0
     OR v.person_id_continuity_healthy IS DISTINCT FROM true OR v.violating_row_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: healthy aggregate returned unexpected values: %', row_to_json(v);
  END IF;
END
$healthy$;
RESET ROLE;

-- Counterfactual: violate each invariant inside a transaction and prove the
-- RPC fails without exposing the duplicate phone id, delivery id, person id,
-- automation id, user id, or any business content.
BEGIN;
ALTER TABLE public.whatsapp_health_state
  DROP CONSTRAINT whatsapp_health_state_phone_number_id_unique;

INSERT INTO auth.users (id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002');
INSERT INTO public.people (id, user_id, name) VALUES (
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'private person name'
);
INSERT INTO public.whatsapp_health_state (user_id, phone_number_id) VALUES
  ('10000000-0000-4000-8000-000000000001', 'counterfactual-private-phone-id'),
  ('10000000-0000-4000-8000-000000000002', 'counterfactual-private-phone-id');
INSERT INTO public.automations (
  id, user_id, title, instruction, assignee_id, cadence_type, next_run_at
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'private title', 'private instruction',
  '30000000-0000-4000-8000-000000000001',
  'daily', now()
);
INSERT INTO public.automation_runs (id, automation_id, user_id, run_for) VALUES (
  '40000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  now()
);
INSERT INTO public.whatsapp_deliveries (
  id, user_id, automation_run_id, source_type, created_at
) VALUES (
  '50000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'automation_delegation', now()
);

SET ROLE anon;
DO $unhealthy$
DECLARE v record;
BEGIN
  SELECT * INTO v
    FROM public.carson_production_canary_health('ci-only-carson-canary-token-0001');
  IF v.canonical_binding_healthy IS DISTINCT FROM false OR v.ambiguous_binding_count <> 1
     OR v.person_id_continuity_healthy IS DISTINCT FROM false OR v.violating_row_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: counterfactual aggregate returned unexpected values: %', row_to_json(v);
  END IF;
END
$unhealthy$;
RESET ROLE;
ROLLBACK;

-- An untrusted caller cannot mutate the configuration or protected tables.
SET ROLE anon;
DO $no_mutation$
BEGIN
  BEGIN
    UPDATE carson_canary_private.config SET updated_at = now();
    RAISE EXCEPTION 'FAIL: anon mutated canary configuration';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.whatsapp_health_state SET phone_number_id = 'mutated';
    RAISE EXCEPTION 'FAIL: anon mutated production health state';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$no_mutation$;
RESET ROLE;

SELECT 'carson canary least-privilege verification complete' AS status;
