/**
 * Legacy-row backward-compatibility verification for
 * upsert_push_subscription(). Deliberately run only ONCE, right after the
 * forward migration's first apply — unlike
 * push_subscriptions_lifecycle_verification.sql (which uses fresh random
 * UUIDs and is safe to rerun after rollback + reapply), the two legacy
 * rows here are fixed, singleton fixtures created once by
 * push_subscriptions_preexisting_fixture.sql. The second assertion below
 * mutates one of them (the lazy-backfill save) — rerunning this file a
 * second time would find a legacy row that already has an
 * installation_id and incorrectly fail the "must be NULL" assertion.
 */

DO $$
DECLARE
  v_legacy_1 uuid; v_legacy_2 uuid;
  v_e1 boolean; v_e2 boolean; v_inst1 uuid; v_inst2 uuid;
BEGIN
  SELECT id, enabled, installation_id INTO v_legacy_1, v_e1, v_inst1
    FROM public.push_subscriptions WHERE endpoint = 'https://push.example/legacy-1';
  SELECT id, enabled, installation_id INTO v_legacy_2, v_e2, v_inst2
    FROM public.push_subscriptions WHERE endpoint = 'https://push.example/legacy-2';

  IF v_legacy_1 IS NULL OR v_legacy_2 IS NULL THEN
    RAISE EXCEPTION 'FAIL: expected pre-existing legacy fixture rows from push_subscriptions_preexisting_fixture.sql to already exist';
  END IF;
  IF v_e1 IS DISTINCT FROM true OR v_e2 IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: pre-existing legacy rows must remain enabled untouched, got e1=%, e2=%', v_e1, v_e2;
  END IF;
  IF v_inst1 IS NOT NULL OR v_inst2 IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: legacy rows must never be auto-backfilled with a guessed installation_id, got inst1=%, inst2=%', v_inst1, v_inst2;
  END IF;

  RAISE NOTICE 'PASS: legacy pre-existing rows are untouched and never guessed at';
END $$;

-- ── Lazy backfill: the legacy row's own device re-saving the SAME
-- endpoint attaches installation_id going forward, with zero migration-
-- time guessing ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner uuid; v_legacy_1 uuid; v_new_install uuid := gen_random_uuid();
  v_result record; v_row public.push_subscriptions;
BEGIN
  SELECT user_id, id INTO v_owner, v_legacy_1
    FROM public.push_subscriptions WHERE endpoint = 'https://push.example/legacy-1';

  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  SELECT * INTO v_result FROM upsert_push_subscription(
    'https://push.example/legacy-1', 'p256dh-1-refreshed', 'auth-1', NULL, 'legacy iPhone UA', 'iPhone', v_new_install);
  RESET ROLE;

  IF v_result.id <> v_legacy_1 THEN
    RAISE EXCEPTION 'FAIL: re-saving the same endpoint must update the same legacy row, got %', v_result.id;
  END IF;

  SELECT * INTO v_row FROM public.push_subscriptions WHERE id = v_legacy_1;
  IF v_row.installation_id IS DISTINCT FROM v_new_install THEN
    RAISE EXCEPTION 'FAIL: legacy row must adopt its real device''s installation_id on next save, got %', v_row.installation_id;
  END IF;

  RAISE NOTICE 'PASS: legacy row lazily adopts installation_id on its own device''s next save';
END $$;

SELECT 'push_subscriptions legacy backfill verification complete' AS status;
