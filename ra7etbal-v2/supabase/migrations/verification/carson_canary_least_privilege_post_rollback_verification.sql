DO $verify_rollback$
BEGIN
  IF to_regprocedure('public.carson_production_canary_health(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: canary RPC survived rollback';
  END IF;
  IF to_regclass('carson_canary_private.config') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: canary configuration survived rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'carson_canary_function_owner') THEN
    RAISE EXCEPTION 'FAIL: canary function owner survived rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE '%: canary aggregate select') THEN
    RAISE EXCEPTION 'FAIL: canary RLS policy survived rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'carson_canary_private') THEN
    RAISE EXCEPTION 'FAIL: canary private schema survived rollback';
  END IF;
END
$verify_rollback$;

SELECT 'carson canary least-privilege rollback verification complete' AS status;
