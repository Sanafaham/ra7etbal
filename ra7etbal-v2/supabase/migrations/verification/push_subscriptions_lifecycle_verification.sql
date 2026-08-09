/**
 * Real-database lifecycle verification for upsert_push_subscription().
 * Runs against a genuine, ephemeral, plain PostgreSQL instance in CI.
 *
 * upsert_push_subscription is SECURITY INVOKER, so every call here goes
 * through `SET ROLE authenticated; PERFORM set_config('request.jwt.claim.sub', ...)`
 * exactly like a real PostgREST request would, so RLS and auth.uid()
 * behave identically to production.
 *
 * Convention matches this repo's existing migration-verification suites:
 * each numbered check is a self-contained DO block, RAISE NOTICE "PASS: ..."
 * on success, RAISE EXCEPTION "FAIL: ..." on failure. Run with
 * `psql -v ON_ERROR_STOP=1` so any failure aborts the CI step immediately.
 */

CREATE TEMP TABLE IF NOT EXISTS _lifecycle_fixture_ids (key text PRIMARY KEY, value uuid);
DELETE FROM _lifecycle_fixture_ids;

-- ── Fixtures: two owners (for cross-user isolation elsewhere), two
-- installations for owner_a ────────────────────────────────────────────
DO $$
DECLARE
  v_owner_a uuid := gen_random_uuid();
  v_owner_b uuid := gen_random_uuid();
  v_install_1 uuid := gen_random_uuid();
  v_install_2 uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id) VALUES (v_owner_a), (v_owner_b);
  INSERT INTO _lifecycle_fixture_ids VALUES
    ('owner_a', v_owner_a), ('owner_b', v_owner_b),
    ('install_1', v_install_1), ('install_2', v_install_2);
  RAISE NOTICE 'PASS: lifecycle fixtures created (owner_a=%, install_1=%, install_2=%)', v_owner_a, v_install_1, v_install_2;
END $$;

-- ── 1. same-endpoint idempotent re-save ─────────────────────────────────
DO $$
DECLARE
  v_owner uuid; v_install uuid;
  v_result1 record; v_result2 record;
  v_enabled_count int;
BEGIN
  SELECT value INTO v_owner FROM _lifecycle_fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_install FROM _lifecycle_fixture_ids WHERE key = 'install_1';

  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);

  SELECT * INTO v_result1 FROM upsert_push_subscription(
    'https://push.example/idempotent', 'p256dh-a', 'auth-a', NULL, 'UA-1', 'iPhone', v_install);
  SELECT * INTO v_result2 FROM upsert_push_subscription(
    'https://push.example/idempotent', 'p256dh-a-refreshed', 'auth-a', NULL, 'UA-1', 'iPhone', v_install);

  RESET ROLE;

  IF v_result1.id <> v_result2.id THEN
    RAISE EXCEPTION 'FAIL: same-endpoint re-save must update the same row, got % then %', v_result1.id, v_result2.id;
  END IF;
  IF v_result2.superseded_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: a pure same-endpoint re-save must supersede nothing, got %', v_result2.superseded_count;
  END IF;

  SELECT count(*) INTO v_enabled_count FROM public.push_subscriptions
    WHERE user_id = v_owner AND installation_id = v_install AND enabled = true;
  IF v_enabled_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: exactly one enabled row expected after idempotent re-save, got %', v_enabled_count;
  END IF;

  RAISE NOTICE 'PASS: 1. same-endpoint idempotent re-save';
END $$;

-- ── 2. different-endpoint rotation supersedes only the prior endpoint ──
DO $$
DECLARE
  v_owner uuid; v_install uuid;
  v_old_id uuid; v_new_result record;
  v_old_enabled boolean;
  v_enabled_count int;
BEGIN
  SELECT value INTO v_owner FROM _lifecycle_fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_install FROM _lifecycle_fixture_ids WHERE key = 'install_2';

  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);

  SELECT id INTO v_old_id FROM upsert_push_subscription(
    'https://push.example/rotate-old', 'p256dh-old', 'auth-old', NULL, 'UA-2', 'iPhone', v_install);
  SELECT * INTO v_new_result FROM upsert_push_subscription(
    'https://push.example/rotate-new', 'p256dh-new', 'auth-new', NULL, 'UA-2', 'iPhone', v_install);

  RESET ROLE;

  SELECT enabled INTO v_old_enabled FROM public.push_subscriptions WHERE id = v_old_id;
  IF v_old_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL: prior endpoint must be disabled after rotation, enabled=%', v_old_enabled;
  END IF;
  IF v_new_result.superseded_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: rotation must report exactly 1 superseded row, got %', v_new_result.superseded_count;
  END IF;

  SELECT count(*) INTO v_enabled_count FROM public.push_subscriptions
    WHERE user_id = v_owner AND installation_id = v_install AND enabled = true;
  IF v_enabled_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: exactly one enabled row expected after rotation, got %', v_enabled_count;
  END IF;

  RAISE NOTICE 'PASS: 2. different-endpoint rotation supersedes only the prior endpoint';
END $$;

-- ── 6. two different installation_ids, same user+platform, independent ─
DO $$
DECLARE
  v_owner uuid; v_install_1 uuid; v_install_2 uuid;
  v_enabled_1 boolean; v_enabled_2 boolean;
BEGIN
  SELECT value INTO v_owner FROM _lifecycle_fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_install_1 FROM _lifecycle_fixture_ids WHERE key = 'install_1';
  SELECT value INTO v_install_2 FROM _lifecycle_fixture_ids WHERE key = 'install_2';

  -- Both installations are already enabled from checks 1 and 2 above
  -- (both are "iPhone" platform — the exact defect this migration fixes).
  SELECT enabled INTO v_enabled_1 FROM public.push_subscriptions
    WHERE user_id = v_owner AND installation_id = v_install_1 AND endpoint = 'https://push.example/idempotent';
  SELECT enabled INTO v_enabled_2 FROM public.push_subscriptions
    WHERE user_id = v_owner AND installation_id = v_install_2 AND endpoint = 'https://push.example/rotate-new';

  IF v_enabled_1 IS DISTINCT FROM true OR v_enabled_2 IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: two distinct same-platform installations must both remain enabled — install_1=%, install_2=%', v_enabled_1, v_enabled_2;
  END IF;

  RAISE NOTICE 'PASS: 6. two different installation_ids on the same user+platform never collide';
END $$;

-- ── 7. partial unique index rejects a direct invariant violation ───────
DO $$
DECLARE
  v_owner uuid; v_install uuid;
  v_caught boolean := false;
BEGIN
  SELECT value INTO v_owner FROM _lifecycle_fixture_ids WHERE key = 'owner_b';
  v_install := gen_random_uuid();

  -- Bypass the RPC entirely — raw SQL as service_role/postgres, proving
  -- the constraint itself (not just the RPC's own logic) enforces the
  -- invariant.
  INSERT INTO public.push_subscriptions
    (user_id, endpoint, p256dh, auth, platform, installation_id, enabled)
  VALUES (v_owner, 'https://push.example/direct-1', 'p', 'a', 'iPhone', v_install, true);

  BEGIN
    INSERT INTO public.push_subscriptions
      (user_id, endpoint, p256dh, auth, platform, installation_id, enabled)
    VALUES (v_owner, 'https://push.example/direct-2', 'p', 'a', 'iPhone', v_install, true);
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: a second enabled row for the same (user_id, installation_id) must be rejected by the partial unique index';
  END IF;

  RAISE NOTICE 'PASS: 7. partial unique index rejects a direct two-enabled-rows violation';
END $$;

-- Legacy pre-existing-row backward-compatibility and lazy-backfill
-- checks live in their own dedicated, run-once file — see
-- push_subscriptions_legacy_backfill_verification.sql — since this file
-- is (deliberately, matching this repo's existing migration-verification
-- convention) rerun after rollback + reapply, and the legacy fixture is a
-- singleton that the backfill check mutates.

SELECT 'push_subscriptions lifecycle verification complete' AS status;
