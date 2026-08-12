\set ON_ERROR_STOP on

-- Catalog proof: RLS is enabled; the existing permissive owner INSERT policy
-- remains; the new policy is authenticated-only, INSERT-only and restrictive.
DO $$
DECLARE
  type_not_null boolean;
  type_default text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tasks'::regclass) THEN
    RAISE EXCEPTION 'tasks RLS is not enabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'tasks'
      AND policyname = 'tasks: owner can insert'
      AND permissive = 'PERMISSIVE' AND cmd = 'INSERT'
      AND roles = ARRAY['authenticated']::name[]
  ) THEN
    RAISE EXCEPTION 'existing owner INSERT policy was removed or changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'tasks'
      AND policyname = 'tasks: reminders require server creation'
      AND permissive = 'RESTRICTIVE' AND cmd = 'INSERT'
      AND roles = ARRAY['authenticated']::name[]
      AND lower(with_check) = '(type <> ''reminder''::text)'
  ) THEN
    RAISE EXCEPTION 'restrictive reminder policy catalog shape is incorrect';
  END IF;

  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tasks') <> 5 THEN
    RAISE EXCEPTION 'unexpected task policy count; a policy may have been dropped or added';
  END IF;

  SELECT attnotnull, pg_get_expr(adbin, adrelid)
    INTO type_not_null, type_default
  FROM pg_attribute
  LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
  WHERE attrelid = 'public.tasks'::regclass AND attname = 'type';

  IF NOT type_not_null OR type_default IS NOT NULL THEN
    RAISE EXCEPTION 'tasks.type must remain NOT NULL with no default';
  END IF;
END $$;

-- Authenticated owner: a direct reminder INSERT is rejected and leaves no row.
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  BEGIN
    INSERT INTO public.tasks (id, user_id, description, type)
    VALUES ('10000000-0000-4000-8000-000000000001', auth.uid(), 'must be rejected', 'reminder');
    RAISE EXCEPTION 'authenticated reminder INSERT unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.tasks WHERE id = '10000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'rejected reminder row persisted';
  END IF;
END $$;

-- Every non-reminder task type currently reachable in production remains valid.
INSERT INTO public.tasks (user_id, description, type, assigned_to) VALUES
  (auth.uid(), 'action survives', 'action', NULL),
  (auth.uid(), 'delegation survives', 'delegation', 'Christopher'),
  (auth.uid(), 'decision survives', 'decision', NULL),
  (auth.uid(), 'followup survives', 'followup', 'Christopher'),
  (auth.uid(), 'errand survives', 'errand', NULL),
  (auth.uid(), 'parked survives', 'parked', NULL);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.tasks WHERE user_id = auth.uid() AND type <> 'reminder') <> 6 THEN
    RAISE EXCEPTION 'one or more legitimate non-reminder types were blocked';
  END IF;
END $$;

-- Existing owner isolation still rejects cross-owner non-reminder INSERTs.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.tasks (id, user_id, description, type)
    VALUES ('10000000-0000-4000-8000-000000000002',
            '22222222-2222-4222-8222-222222222222', 'cross-owner', 'action');
    RAISE EXCEPTION 'cross-owner INSERT unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;

-- NULL and omitted types fail closed. PostgreSQL evaluates the restrictive
-- WITH CHECK before the unchanged NOT NULL constraint, while the catalog proof
-- above independently confirms that type is also NOT NULL with no default.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.tasks (user_id, description, type) VALUES (auth.uid(), 'null type', NULL);
    RAISE EXCEPTION 'NULL type unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.tasks (user_id, description) VALUES (auth.uid(), 'omitted type');
    RAISE EXCEPTION 'omitted type unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- Pre-existing reminders retain the same SELECT, UPDATE and DELETE behavior.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tasks WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') THEN
    RAISE EXCEPTION 'pre-existing reminder is no longer selectable';
  END IF;
END $$;
UPDATE public.tasks SET description = 'pre-existing reminder updated'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DELETE FROM public.tasks WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tasks
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND description = 'pre-existing reminder updated'
  ) THEN
    RAISE EXCEPTION 'pre-existing reminder update changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tasks WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') THEN
    RAISE EXCEPTION 'pre-existing reminder delete changed';
  END IF;
END $$;

-- Server-owned creation still works through Supabase's BYPASSRLS role.
SET ROLE service_role;
INSERT INTO public.tasks (id, user_id, description, type)
VALUES ('10000000-0000-4000-8000-000000000003',
        '11111111-1111-4111-8111-111111111111', 'server reminder', 'reminder');
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tasks WHERE id = '10000000-0000-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'service_role reminder INSERT failed';
  END IF;
END $$;

SELECT 'server-authoritative reminder RLS verification passed' AS result;
