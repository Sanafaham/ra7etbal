/**
 * Real, genuine two-connection concurrency verification for
 * upsert_push_subscription(). Runs against a genuine, ephemeral, plain
 * PostgreSQL instance in CI.
 *
 * Unlike a same-session sequential test (which can prove logical
 * correctness but cannot prove that concurrent callers actually block on
 * each other), this file uses the dblink extension to open a real, second
 * Postgres backend connection ("session B") while the local script's own
 * connection ("session A") holds an explicit, uncommitted transaction
 * open — genuinely proving the pg_advisory_xact_lock inside
 * upsert_push_subscription blocks a truly concurrent caller, not just
 * that one call at a time is internally atomic.
 */

CREATE EXTENSION IF NOT EXISTS dblink;

CREATE TEMP TABLE IF NOT EXISTS _concurrency_fixture_ids (key text PRIMARY KEY, value uuid);
DELETE FROM _concurrency_fixture_ids;

-- ══════════════════════════════════════════════════════════════════════
-- Test 3: two genuinely concurrent FIRST-TIME saves for one installation
-- (no prior row). Neither call may know about the other in advance.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_install uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id) VALUES (v_owner);
  INSERT INTO _concurrency_fixture_ids VALUES ('t3_owner', v_owner), ('t3_install', v_install);
END $$;

-- Session A: open an explicit transaction and complete its own save.
-- The advisory lock for (owner, install) remains held as long as this
-- transaction stays open — that's the whole point of the test below.
BEGIN;

DO $$
DECLARE
  v_owner uuid; v_install uuid;
BEGIN
  SELECT value INTO v_owner FROM _concurrency_fixture_ids WHERE key = 't3_owner';
  SELECT value INTO v_install FROM _concurrency_fixture_ids WHERE key = 't3_install';

  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM upsert_push_subscription('https://push.example/conc3-a', 'p256dh-a', 'auth-a', NULL, 'UA', 'iPhone', v_install);
  RESET ROLE;
END $$;

-- Session B: a genuinely separate Postgres backend via dblink, firing the
-- second save WHILE session A's transaction (and its advisory lock) is
-- still open. This must block.
DO $$
DECLARE
  v_owner uuid; v_install uuid;
  v_conn text := 'host=localhost port=' || current_setting('port') || ' dbname=' || current_database() || ' user=' || current_user;
BEGIN
  SELECT value INTO v_owner FROM _concurrency_fixture_ids WHERE key = 't3_owner';
  SELECT value INTO v_install FROM _concurrency_fixture_ids WHERE key = 't3_install';

  PERFORM dblink_connect('conc_b', v_conn);
  PERFORM dblink_exec('conc_b', 'SET ROLE authenticated');
  -- dblink_exec rejects any statement that returns a result set (a plain
  -- SELECT set_config(...) call does) — use the SET command form instead,
  -- which returns no rows and persists for the rest of this connection.
  PERFORM dblink_exec('conc_b', format('SET request.jwt.claim.sub = %L', v_owner::text));
  PERFORM dblink_send_query('conc_b', format(
    'SELECT * FROM upsert_push_subscription(%L, %L, %L, NULL, %L, %L, %L)',
    'https://push.example/conc3-b', 'p256dh-b', 'auth-b', 'UA', 'iPhone', v_install));

  PERFORM pg_sleep(0.3);
  IF dblink_is_busy('conc_b') = 0 THEN
    RAISE EXCEPTION 'FAIL: session B must still be blocked on the advisory lock while session A''s transaction is open — the lock is not actually serializing concurrent callers';
  END IF;
END $$;

-- Release session A's transaction — and its advisory lock.
COMMIT;

-- Session B should now unblock, run to completion, and see session A's
-- committed row (proving it took a FRESH snapshot after the lock cleared,
-- not a stale pre-block snapshot).
DO $$
DECLARE
  v_result record;
BEGIN
  PERFORM pg_sleep(0.2);
  SELECT * INTO v_result FROM dblink_get_result('conc_b', true) AS t(id uuid, superseded_count int);
  PERFORM dblink_disconnect('conc_b');

  IF v_result.superseded_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: session B must observe and supersede session A''s committed row after unblocking, superseded_count=%', v_result.superseded_count;
  END IF;
END $$;

DO $$
DECLARE
  v_owner uuid; v_install uuid; v_enabled_count int;
BEGIN
  SELECT value INTO v_owner FROM _concurrency_fixture_ids WHERE key = 't3_owner';
  SELECT value INTO v_install FROM _concurrency_fixture_ids WHERE key = 't3_install';

  SELECT count(*) INTO v_enabled_count FROM public.push_subscriptions
    WHERE user_id = v_owner AND installation_id = v_install AND enabled = true;
  IF v_enabled_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: exactly one enabled row expected after two genuinely concurrent first-time saves, got %', v_enabled_count;
  END IF;

  RAISE NOTICE 'PASS: 3. two genuinely concurrent first-time saves for one installation never both stay enabled';
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- Test 4: two genuinely concurrent ROTATIONS for one installation that
-- already has an enabled subscription.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_install uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id) VALUES (v_owner);
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, platform, installation_id, enabled)
    VALUES (v_owner, 'https://push.example/conc4-original', 'p256dh-orig', 'auth-orig', 'iPhone', v_install, true);
  INSERT INTO _concurrency_fixture_ids VALUES ('t4_owner', v_owner), ('t4_install', v_install);
END $$;

BEGIN;

DO $$
DECLARE
  v_owner uuid; v_install uuid;
BEGIN
  SELECT value INTO v_owner FROM _concurrency_fixture_ids WHERE key = 't4_owner';
  SELECT value INTO v_install FROM _concurrency_fixture_ids WHERE key = 't4_install';

  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM upsert_push_subscription('https://push.example/conc4-rotate-a', 'p256dh-a', 'auth-a', NULL, 'UA', 'iPhone', v_install);
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_owner uuid; v_install uuid;
  v_conn text := 'host=localhost port=' || current_setting('port') || ' dbname=' || current_database() || ' user=' || current_user;
BEGIN
  SELECT value INTO v_owner FROM _concurrency_fixture_ids WHERE key = 't4_owner';
  SELECT value INTO v_install FROM _concurrency_fixture_ids WHERE key = 't4_install';

  PERFORM dblink_connect('conc_b4', v_conn);
  PERFORM dblink_exec('conc_b4', 'SET ROLE authenticated');
  PERFORM dblink_exec('conc_b4', format('SET request.jwt.claim.sub = %L', v_owner::text));
  PERFORM dblink_send_query('conc_b4', format(
    'SELECT * FROM upsert_push_subscription(%L, %L, %L, NULL, %L, %L, %L)',
    'https://push.example/conc4-rotate-b', 'p256dh-b', 'auth-b', 'UA', 'iPhone', v_install));

  PERFORM pg_sleep(0.3);
  IF dblink_is_busy('conc_b4') = 0 THEN
    RAISE EXCEPTION 'FAIL: session B''s concurrent rotation must still be blocked while session A''s rotation transaction is open';
  END IF;
END $$;

COMMIT;

DO $$
DECLARE
  v_result record;
BEGIN
  PERFORM pg_sleep(0.2);
  SELECT * INTO v_result FROM dblink_get_result('conc_b4', true) AS t(id uuid, superseded_count int);
  PERFORM dblink_disconnect('conc_b4');

  IF v_result.superseded_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: session B''s rotation must supersede exactly session A''s just-committed row, superseded_count=%', v_result.superseded_count;
  END IF;
END $$;

DO $$
DECLARE
  v_owner uuid; v_install uuid; v_enabled_count int;
BEGIN
  SELECT value INTO v_owner FROM _concurrency_fixture_ids WHERE key = 't4_owner';
  SELECT value INTO v_install FROM _concurrency_fixture_ids WHERE key = 't4_install';

  SELECT count(*) INTO v_enabled_count FROM public.push_subscriptions
    WHERE user_id = v_owner AND installation_id = v_install AND enabled = true;
  IF v_enabled_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: exactly one enabled row expected after two genuinely concurrent rotations, got %', v_enabled_count;
  END IF;

  RAISE NOTICE 'PASS: 4. two genuinely concurrent rotations for one installation never both stay enabled — original and loser both disabled, deterministic single winner';
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- Test 5: a failure in the terminal upsert rolls back the earlier
-- disable, leaving the prior subscription exactly as it was.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_install uuid := gen_random_uuid();
  v_old_id uuid;
  v_caught boolean := false;
  v_old_enabled boolean;
BEGIN
  INSERT INTO auth.users (id) VALUES (v_owner);
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, platform, installation_id, enabled)
    VALUES (v_owner, 'https://push.example/conc5-original', 'p256dh-orig', 'auth-orig', 'iPhone', v_install, true)
  RETURNING id INTO v_old_id;

  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);

  -- p_p256dh = NULL deliberately violates p256dh's NOT NULL constraint at
  -- the terminal INSERT step, AFTER the earlier disable-others UPDATE has
  -- already run inside this same function call.
  BEGIN
    PERFORM upsert_push_subscription('https://push.example/conc5-will-fail', NULL, 'auth-fail', NULL, 'UA', 'iPhone', v_install);
  EXCEPTION WHEN not_null_violation THEN
    v_caught := true;
  END;

  RESET ROLE;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: expected a not_null_violation from the deliberately invalid terminal upsert';
  END IF;

  SELECT enabled INTO v_old_enabled FROM public.push_subscriptions WHERE id = v_old_id;
  IF v_old_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: the prior subscription must remain enabled after a rolled-back terminal upsert failure, got enabled=%', v_old_enabled;
  END IF;

  RAISE NOTICE 'PASS: 5. a terminal upsert failure rolls back the earlier disable, preserving the prior working subscription';
END $$;

SELECT 'push_subscriptions concurrency verification complete' AS status;
