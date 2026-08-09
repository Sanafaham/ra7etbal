/**
 * Pre-existing production-shaped data, inserted BEFORE the forward
 * migration under test. Proves the migration is truly additive: these
 * rows (representing today's real ~20-row legacy backlog, all with no
 * installation_id) must keep existing, keep their exact enabled state,
 * and never be touched by the migration itself or by the RPC of a
 * different installation — and must survive a rollback + reapply cycle.
 */

CREATE TEMP TABLE IF NOT EXISTS _legacy_fixture_ids (key text PRIMARY KEY, value uuid);
DELETE FROM _legacy_fixture_ids;

DO $$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_legacy_1 uuid;
  v_legacy_2 uuid;
BEGIN
  INSERT INTO auth.users (id) VALUES (v_owner);

  INSERT INTO public.push_subscriptions
    (user_id, endpoint, p256dh, auth, platform, user_agent, enabled)
  VALUES
    (v_owner, 'https://push.example/legacy-1', 'p256dh-1', 'auth-1', 'iPhone', 'legacy iPhone UA', true)
  RETURNING id INTO v_legacy_1;

  INSERT INTO public.push_subscriptions
    (user_id, endpoint, p256dh, auth, platform, user_agent, enabled)
  VALUES
    (v_owner, 'https://push.example/legacy-2', 'p256dh-2', 'auth-2', 'iPhone', 'legacy iPhone UA', true)
  RETURNING id INTO v_legacy_2;

  INSERT INTO _legacy_fixture_ids VALUES
    ('owner', v_owner), ('legacy_1', v_legacy_1), ('legacy_2', v_legacy_2);

  RAISE NOTICE 'PASS: pre-existing legacy fixtures created (owner=%, legacy_1=%, legacy_2=%)', v_owner, v_legacy_1, v_legacy_2;
END $$;
