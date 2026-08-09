/**
 * Post-rollback verification for
 * 20260810_push_subscription_installation_identity.rollback.sql. Confirms
 * a clean reversal (function/indexes/column gone) and that pre-existing
 * data (including rows written during the forward-migration verification
 * passes) survives untouched.
 */

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'upsert_push_subscription'
  ) THEN
    RAISE EXCEPTION 'FAIL: upsert_push_subscription must not exist after rollback';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname IN (
      'push_subscriptions_one_enabled_per_installation',
      'push_subscriptions_user_installation_idx'
    )
  ) THEN
    RAISE EXCEPTION 'FAIL: both new indexes must be dropped after rollback';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'installation_id'
  ) THEN
    RAISE EXCEPTION 'FAIL: installation_id column must be dropped after rollback';
  END IF;

  RAISE NOTICE 'PASS: rollback cleanly removed the function, both indexes, and the column';
END $$;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.push_subscriptions
    WHERE endpoint IN ('https://push.example/legacy-1', 'https://push.example/legacy-2') AND enabled = true;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'FAIL: pre-existing legacy rows must survive rollback untouched, found % of 2 still enabled', v_count;
  END IF;

  RAISE NOTICE 'PASS: pre-existing data survives rollback untouched';
END $$;

SELECT 'push_subscriptions post-rollback verification complete' AS status;
