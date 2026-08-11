DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_task_1 uuid := gen_random_uuid();
  v_task_2 uuid := gen_random_uuid();
  v_constraint_name text;
BEGIN
  INSERT INTO auth.users (id) VALUES (v_user);
  INSERT INTO public.tasks (id, user_id) VALUES
    (v_task_1, v_user),
    (v_task_2, v_user);

  -- First owner-reminder lifecycle for a task owns the durable claim.
  INSERT INTO public.whatsapp_deliveries (user_id, task_id, source_type)
  VALUES (v_user, v_task_1, 'owner_reminder');

  -- A second owner-reminder lifecycle for the same task must be rejected by
  -- the exact partial unique index, not by a broad task_id constraint.
  BEGIN
    INSERT INTO public.whatsapp_deliveries (user_id, task_id, source_type)
    VALUES (v_user, v_task_1, 'owner_reminder');
    RAISE EXCEPTION 'FAIL: duplicate owner_reminder insert unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name <> 'whatsapp_deliveries_owner_reminder_task_uidx' THEN
      RAISE EXCEPTION 'FAIL: wrong constraint rejected duplicate: %', v_constraint_name;
    END IF;
  END;

  -- Other delivery lifecycles may still reference the same canonical task.
  INSERT INTO public.whatsapp_deliveries (user_id, task_id, source_type)
  VALUES (v_user, v_task_1, 'delegation');

  -- Owner reminders for a different task remain independent.
  INSERT INTO public.whatsapp_deliveries (user_id, task_id, source_type)
  VALUES (v_user, v_task_2, 'owner_reminder');

  IF (SELECT count(*) FROM public.whatsapp_deliveries
      WHERE task_id = v_task_1 AND source_type = 'owner_reminder') <> 1 THEN
    RAISE EXCEPTION 'FAIL: task 1 must have exactly one owner_reminder lifecycle';
  END IF;
  IF (SELECT count(*) FROM public.whatsapp_deliveries
      WHERE task_id = v_task_1 AND source_type = 'delegation') <> 1 THEN
    RAISE EXCEPTION 'FAIL: another source_type must remain allowed for task 1';
  END IF;
  IF (SELECT count(*) FROM public.whatsapp_deliveries
      WHERE task_id = v_task_2 AND source_type = 'owner_reminder') <> 1 THEN
    RAISE EXCEPTION 'FAIL: task 2 must allow its own owner_reminder lifecycle';
  END IF;

  RAISE NOTICE 'PASS: owner reminder partial unique claim lifecycle';
END $$;
