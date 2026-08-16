/**
 * Real-Postgres contract verification for google_oauth_states
 * (20260816_google_oauth_states.sql), run against a genuine, ephemeral
 * PostgreSQL instance in CI via 00_bootstrap_minimal_auth.sql.
 *
 * GRANT ALL ... TO service_role below exists ONLY because
 * 00_bootstrap_minimal_auth.sql is "NOT a full Supabase emulation" (its
 * own docstring) and does not reproduce Supabase's platform-level default
 * privilege grant to service_role on every new public-schema table. In
 * real Supabase this is automatic and no migration in this repo ever
 * grants it explicitly (confirmed: 20260622_whatsapp_health_state.sql,
 * the closest precedent for a service-role-written/authenticated-read
 * table, grants nothing to service_role either) — this line is test
 * infrastructure only, not a statement that production needs this grant.
 */

GRANT ALL ON public.google_oauth_states TO service_role;

CREATE TEMP TABLE IF NOT EXISTS _oauth_state_fixture_ids (key text PRIMARY KEY, value uuid);
DELETE FROM _oauth_state_fixture_ids;

DO $$
DECLARE
  v_user_a uuid := gen_random_uuid();
  v_user_b uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id) VALUES (v_user_a), (v_user_b);
  INSERT INTO _oauth_state_fixture_ids VALUES ('user_a', v_user_a), ('user_b', v_user_b);
END $$;

-- ── 1. state_hash uniqueness is enforced ────────────────────────────────
DO $$
DECLARE
  v_user_a uuid;
  v_caught boolean := false;
BEGIN
  SELECT value INTO v_user_a FROM _oauth_state_fixture_ids WHERE key = 'user_a';

  INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
  VALUES (v_user_a, 'duplicate-hash-test', now() + interval '10 minutes');

  BEGIN
    INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
    VALUES (v_user_a, 'duplicate-hash-test', now() + interval '10 minutes');
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;

  DELETE FROM public.google_oauth_states WHERE state_hash = 'duplicate-hash-test';

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: state_hash uniqueness was not enforced';
  END IF;
  RAISE NOTICE 'PASS: 1. state_hash uniqueness enforced';
END $$;

-- ── 2. user_id foreign key is enforced ──────────────────────────────────
DO $$
DECLARE
  v_caught boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
    VALUES (gen_random_uuid(), 'fk-test-hash', now() + interval '10 minutes');
  EXCEPTION WHEN foreign_key_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: user_id foreign key was not enforced';
  END IF;
  RAISE NOTICE 'PASS: 2. user_id foreign key enforced';
END $$;

-- ── 3. ON DELETE CASCADE behaves correctly ──────────────────────────────
DO $$
DECLARE
  v_cascade_user uuid := gen_random_uuid();
  v_remaining int;
BEGIN
  INSERT INTO auth.users (id) VALUES (v_cascade_user);
  INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
  VALUES (v_cascade_user, 'cascade-test-hash', now() + interval '10 minutes');

  DELETE FROM auth.users WHERE id = v_cascade_user;

  SELECT count(*) INTO v_remaining FROM public.google_oauth_states WHERE state_hash = 'cascade-test-hash';
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'FAIL: google_oauth_states row survived its user_id being deleted (ON DELETE CASCADE did not fire)';
  END IF;
  RAISE NOTICE 'PASS: 3. ON DELETE CASCADE removes the dependent state row';
END $$;

-- ── 4. anon cannot read, insert, update, or delete ──────────────────────
DO $$
DECLARE
  v_user_a uuid;
  v_caught_select boolean := false;
  v_caught_insert boolean := false;
  v_caught_update boolean := false;
  v_caught_delete boolean := false;
BEGIN
  SELECT value INTO v_user_a FROM _oauth_state_fixture_ids WHERE key = 'user_a';
  INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
  VALUES (v_user_a, 'anon-probe-hash', now() + interval '10 minutes');

  SET ROLE anon;

  BEGIN
    PERFORM * FROM public.google_oauth_states LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_select := true;
  END;

  BEGIN
    INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
    VALUES (v_user_a, 'anon-insert-attempt', now() + interval '10 minutes');
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_insert := true;
  END;

  BEGIN
    UPDATE public.google_oauth_states SET expires_at = now() + interval '1 hour' WHERE state_hash = 'anon-probe-hash';
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_update := true;
  END;

  BEGIN
    DELETE FROM public.google_oauth_states WHERE state_hash = 'anon-probe-hash';
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_delete := true;
  END;

  RESET ROLE;
  DELETE FROM public.google_oauth_states WHERE state_hash = 'anon-probe-hash';

  IF NOT (v_caught_select AND v_caught_insert AND v_caught_update AND v_caught_delete) THEN
    RAISE EXCEPTION 'FAIL: anon select=% insert=% update=% delete=% (all must be true)',
      v_caught_select, v_caught_insert, v_caught_update, v_caught_delete;
  END IF;
  RAISE NOTICE 'PASS: 4. anon cannot select, insert, update, or delete';
END $$;

-- ── 5. authenticated cannot read, insert, update, or delete ────────────
DO $$
DECLARE
  v_user_a uuid;
  v_caught_select boolean := false;
  v_caught_insert boolean := false;
  v_caught_update boolean := false;
  v_caught_delete boolean := false;
BEGIN
  SELECT value INTO v_user_a FROM _oauth_state_fixture_ids WHERE key = 'user_a';
  INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
  VALUES (v_user_a, 'authenticated-probe-hash', now() + interval '10 minutes');

  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);

  BEGIN
    PERFORM * FROM public.google_oauth_states LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_select := true;
  END;

  BEGIN
    INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
    VALUES (v_user_a, 'authenticated-insert-attempt', now() + interval '10 minutes');
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_insert := true;
  END;

  BEGIN
    UPDATE public.google_oauth_states SET expires_at = now() + interval '1 hour' WHERE state_hash = 'authenticated-probe-hash';
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_update := true;
  END;

  BEGIN
    DELETE FROM public.google_oauth_states WHERE state_hash = 'authenticated-probe-hash';
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_delete := true;
  END;

  RESET ROLE;
  DELETE FROM public.google_oauth_states WHERE state_hash = 'authenticated-probe-hash';

  IF NOT (v_caught_select AND v_caught_insert AND v_caught_update AND v_caught_delete) THEN
    RAISE EXCEPTION 'FAIL: authenticated select=% insert=% update=% delete=% (all must be true)',
      v_caught_select, v_caught_insert, v_caught_update, v_caught_delete;
  END IF;
  RAISE NOTICE 'PASS: 5. authenticated cannot select, insert, update, or delete (even for its own user_id)';
END $$;

-- ── 6. service_role (the server path) can create and consume state ─────
DO $$
DECLARE
  v_user_a uuid;
  v_returned_user uuid;
BEGIN
  SELECT value INTO v_user_a FROM _oauth_state_fixture_ids WHERE key = 'user_a';

  SET ROLE service_role;
  INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
  VALUES (v_user_a, 'service-role-create-consume', now() + interval '10 minutes');

  DELETE FROM public.google_oauth_states
  WHERE state_hash = 'service-role-create-consume' AND expires_at > now()
  RETURNING user_id INTO v_returned_user;
  RESET ROLE;

  IF v_returned_user IS DISTINCT FROM v_user_a THEN
    RAISE EXCEPTION 'FAIL: service_role could not create and consume its own state row (got %)', v_returned_user;
  END IF;
  RAISE NOTICE 'PASS: 6. service_role can create and consume state';
END $$;

-- ── 7. expired state cannot be accepted by the application's own query ─
DO $$
DECLARE
  v_user_a uuid;
  v_returned_user uuid;
  v_remaining int;
BEGIN
  SELECT value INTO v_user_a FROM _oauth_state_fixture_ids WHERE key = 'user_a';

  SET ROLE service_role;
  INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
  VALUES (v_user_a, 'expired-state-hash', now() - interval '1 minute');

  -- This is the exact query api/google-calendar.js's callback runs.
  DELETE FROM public.google_oauth_states
  WHERE state_hash = 'expired-state-hash' AND expires_at > now()
  RETURNING user_id INTO v_returned_user;

  SELECT count(*) INTO v_remaining FROM public.google_oauth_states WHERE state_hash = 'expired-state-hash';
  RESET ROLE;

  IF v_returned_user IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: an expired state was accepted, returned user_id %', v_returned_user;
  END IF;
  IF v_remaining <> 1 THEN
    RAISE EXCEPTION 'FAIL: the expired row should remain untouched (still expired, not deleted by a failed consume), found %', v_remaining;
  END IF;

  DELETE FROM public.google_oauth_states WHERE state_hash = 'expired-state-hash';
  RAISE NOTICE 'PASS: 7. expired state is rejected by the application query (zero rows returned, nothing deleted)';
END $$;

-- ── 8. a valid state can be consumed exactly once (sequential proof) ───
DO $$
DECLARE
  v_user_a uuid;
  v_first_result uuid;
  v_second_result uuid;
BEGIN
  SELECT value INTO v_user_a FROM _oauth_state_fixture_ids WHERE key = 'user_a';

  SET ROLE service_role;
  INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
  VALUES (v_user_a, 'single-use-sequential-hash', now() + interval '10 minutes');

  DELETE FROM public.google_oauth_states
  WHERE state_hash = 'single-use-sequential-hash' AND expires_at > now()
  RETURNING user_id INTO v_first_result;

  DELETE FROM public.google_oauth_states
  WHERE state_hash = 'single-use-sequential-hash' AND expires_at > now()
  RETURNING user_id INTO v_second_result;
  RESET ROLE;

  IF v_first_result IS DISTINCT FROM v_user_a THEN
    RAISE EXCEPTION 'FAIL: first consumption should have returned user_id %, got %', v_user_a, v_first_result;
  END IF;
  IF v_second_result IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: replaying the same state a second time must return nothing, got %', v_second_result;
  END IF;
  RAISE NOTICE 'PASS: 8. state is consumed exactly once (sequential replay rejected)';
END $$;

-- ── 9. two genuinely concurrent consumption attempts for the SAME state
-- cannot both succeed. Uses dblink to open a real second Postgres
-- connection/transaction, the same pattern already established by
-- owner_notifications_concurrency_verification.sql. Session A opens the
-- state's row inside an uncommitted transaction (holding its row lock);
-- session B's identical DELETE is issued concurrently and must block on
-- that lock, not silently succeed against a duplicate view of the row.
-- When A commits, B's DELETE resumes and finds the row already gone. ───
CREATE EXTENSION IF NOT EXISTS dblink;

DO $$
DECLARE
  v_user_a uuid;
BEGIN
  SELECT value INTO v_user_a FROM _oauth_state_fixture_ids WHERE key = 'user_a';

  SET ROLE service_role;
  INSERT INTO public.google_oauth_states (user_id, state_hash, expires_at)
  VALUES (v_user_a, 'race-test-hash', now() + interval '10 minutes');
  RESET ROLE;
END $$;

BEGIN;
SET ROLE service_role;
DO $$
DECLARE
  v_a_result uuid;
BEGIN
  -- Session A: consume, but hold the transaction open (no COMMIT yet) so
  -- the row-level lock this DELETE takes is still held.
  DELETE FROM public.google_oauth_states
  WHERE state_hash = 'race-test-hash' AND expires_at > now()
  RETURNING user_id INTO v_a_result;

  IF v_a_result IS NULL THEN
    RAISE EXCEPTION 'FAIL: session A (first mover) should have consumed the race-test row';
  END IF;
END $$;

-- dblink_connect refuses a passwordless conninfo unless the CALLING role
-- is a superuser -- RESET ROLE back to the superuser bootstrap role for
-- the call itself; the dblink session below does its own SET ROLE
-- service_role once connected, so the actual consuming DELETE still runs
-- with service_role's exact effective privileges.
RESET ROLE;

DO $$
DECLARE
  v_conn text := 'host=localhost port=' || current_setting('port') || ' dbname=' || current_database() || ' user=' || current_user;
BEGIN
  PERFORM dblink_connect('oauth_state_race_b', v_conn);
  PERFORM dblink_exec('oauth_state_race_b', 'SET ROLE service_role');
  -- Session B issues the SAME consuming DELETE while A's transaction (and
  -- its row lock on the now-deleted-but-not-yet-committed row) is still
  -- open. A real second connection, a real concurrent statement -- not a
  -- simulated/sequential call.
  PERFORM dblink_send_query('oauth_state_race_b', $query$
    DELETE FROM public.google_oauth_states
    WHERE state_hash = 'race-test-hash' AND expires_at > now()
    RETURNING user_id
  $query$);
  PERFORM pg_sleep(0.2);
  IF dblink_is_busy('oauth_state_race_b') = 0 THEN
    RAISE EXCEPTION 'FAIL: the concurrent second consumption attempt did not block on session A''s uncommitted row lock -- the race was not actually exercised';
  END IF;
END $$;
RESET ROLE;
COMMIT;

DO $$
DECLARE
  v_b_result record;
  v_got_row boolean;
  v_remaining int;
BEGIN
  -- Now that A has committed, B's blocked DELETE resumes and re-checks
  -- its WHERE clause -- the row is gone, so B must get zero rows back.
  BEGIN
    SELECT * INTO v_b_result FROM dblink_get_result('oauth_state_race_b', false) AS t(user_id uuid);
    v_got_row := FOUND AND v_b_result.user_id IS NOT NULL;
  EXCEPTION WHEN OTHERS THEN
    v_got_row := false;
  END;
  PERFORM dblink_disconnect('oauth_state_race_b');

  IF v_got_row THEN
    RAISE EXCEPTION 'FAIL: session B (the loser of the race) must not have consumed the row too -- both concurrent attempts succeeded';
  END IF;

  SELECT count(*) INTO v_remaining FROM public.google_oauth_states WHERE state_hash = 'race-test-hash';
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'FAIL: the race-test row should be gone (consumed exactly once by session A), found %', v_remaining;
  END IF;

  RAISE NOTICE 'PASS: 9. two concurrent consumption attempts for the same state cannot both succeed';
END $$;

-- ── Cleanup ──────────────────────────────────────────────────────────────
DELETE FROM public.google_oauth_states
WHERE user_id IN (SELECT value FROM _oauth_state_fixture_ids);
DELETE FROM auth.users WHERE id IN (SELECT value FROM _oauth_state_fixture_ids);

SELECT 'google_oauth_states verification complete' AS status;
