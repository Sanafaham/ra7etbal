/**
 * RPC privilege boundary + cross-user isolation verification for
 * upsert_push_subscription(). Runs against a genuine, ephemeral, plain
 * PostgreSQL instance in CI.
 */

CREATE TEMP TABLE IF NOT EXISTS _security_fixture_ids (key text PRIMARY KEY, value uuid);
DELETE FROM _security_fixture_ids;

DO $$
DECLARE
  v_owner_a uuid := gen_random_uuid();
  v_owner_b uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id) VALUES (v_owner_a), (v_owner_b);
  INSERT INTO _security_fixture_ids VALUES ('owner_a', v_owner_a), ('owner_b', v_owner_b);
END $$;

-- ── 8/9. EXECUTE grants: PUBLIC/anon forbidden, authenticated allowed ──
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.upsert_push_subscription(text,text,text,timestamptz,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon must not be granted EXECUTE on upsert_push_subscription';
  END IF;
  IF has_function_privilege('public', 'public.upsert_push_subscription(text,text,text,timestamptz,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: PUBLIC must not retain the default EXECUTE grant on upsert_push_subscription';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.upsert_push_subscription(text,text,text,timestamptz,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated must be granted EXECUTE on upsert_push_subscription';
  END IF;
  RAISE NOTICE 'PASS: grants — PUBLIC/anon forbidden, authenticated allowed';
END $$;

-- ── 8. anon genuinely cannot execute (real permission-denied observed,
-- not just a grant-table check) ─────────────────────────────────────────
DO $$
DECLARE
  v_caught boolean := false;
BEGIN
  SET ROLE anon;
  BEGIN
    PERFORM upsert_push_subscription('https://push.example/anon-attempt', 'p', 'a', NULL, 'UA', 'iPhone', gen_random_uuid());
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;
  RESET ROLE;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: anon must not be able to execute upsert_push_subscription';
  END IF;
  RAISE NOTICE 'PASS: 8. anon cannot execute upsert_push_subscription (real permission-denied observed)';
END $$;

-- ── 9. authenticated genuinely can execute (already exercised
-- extensively in the lifecycle/concurrency suites; direct minimal proof
-- here) ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner uuid;
  v_result record;
BEGIN
  SELECT value INTO v_owner FROM _security_fixture_ids WHERE key = 'owner_a';

  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  SELECT * INTO v_result FROM upsert_push_subscription('https://push.example/auth-ok', 'p', 'a', NULL, 'UA', 'iPhone', gen_random_uuid());
  RESET ROLE;

  IF v_result.id IS NULL THEN
    RAISE EXCEPTION 'FAIL: authenticated call should have succeeded and returned an id';
  END IF;
  RAISE NOTICE 'PASS: 9. authenticated can execute upsert_push_subscription';
END $$;

-- ── 10. cross-user isolation: owner_b's save can never see or supersede
-- owner_a's rows, even reusing the exact same installation_id (RLS's
-- auth.uid() = user_id scoping, not just app-level filtering) ──────────
DO $$
DECLARE
  v_owner_a uuid; v_owner_b uuid;
  v_shared_install uuid := gen_random_uuid();
  v_a_id uuid; v_b_result record;
  v_a_enabled boolean;
  v_visible_to_b int;
BEGIN
  SELECT value INTO v_owner_a FROM _security_fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_owner_b FROM _security_fixture_ids WHERE key = 'owner_b';

  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_owner_a::text, true);
  SELECT id INTO v_a_id FROM upsert_push_subscription('https://push.example/cross-user-a', 'p', 'a', NULL, 'UA', 'iPhone', v_shared_install);

  -- Reusing the SAME installation_id as a different user — must never
  -- touch owner_a's row, must never even see it.
  PERFORM set_config('request.jwt.claim.sub', v_owner_b::text, true);
  SELECT * INTO v_b_result FROM upsert_push_subscription('https://push.example/cross-user-b', 'p', 'a', NULL, 'UA', 'iPhone', v_shared_install);

  SELECT count(*) INTO v_visible_to_b FROM public.push_subscriptions WHERE id = v_a_id;
  RESET ROLE;

  IF v_visible_to_b <> 0 THEN
    RAISE EXCEPTION 'FAIL: owner_b must not even see owner_a''s row under RLS, saw %', v_visible_to_b;
  END IF;
  IF v_b_result.superseded_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: owner_b''s save must never supersede owner_a''s row despite the same installation_id, superseded_count=%', v_b_result.superseded_count;
  END IF;

  SELECT enabled INTO v_a_enabled FROM public.push_subscriptions WHERE id = v_a_id;
  IF v_a_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: owner_a''s row must remain enabled and untouched, got %', v_a_enabled;
  END IF;

  RAISE NOTICE 'PASS: 10. cross-user isolation holds even when two different users share the same installation_id value';
END $$;

SELECT 'push_subscriptions security verification complete' AS status;
