BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('10000000-0000-4000-8000-000000000001', 'notification-a@example.test'),
  ('20000000-0000-4000-8000-000000000002', 'notification-b@example.test');

INSERT INTO public.owner_notifications
  (id, user_id, event_key, kind, title, body, occurred_at, read_at)
VALUES
  ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'reminder_due:one', 'reminder_due', 'Ra7etBal', 'One', now(), NULL),
  ('a0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'reminder_due:two', 'reminder_due', 'Ra7etBal', 'Two', now(), NULL),
  ('b0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'reminder_due:one', 'reminder_due', 'Ra7etBal', 'Other owner', now(), NULL);

DO $$
DECLARE v_constraint_name text;
BEGIN
  BEGIN
    INSERT INTO public.owner_notifications
      (user_id, event_key, kind, title, body, occurred_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', 'reminder_due:one', 'reminder_due', 'Ra7etBal', 'Duplicate', now());
    RAISE EXCEPTION 'FAIL: duplicate insert unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name <> 'owner_notifications_user_event_key_key' THEN
      RAISE EXCEPTION 'FAIL: wrong constraint rejected duplicate: %', v_constraint_name;
    END IF;
  END;
END $$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  IF (SELECT count(*) FROM public.owner_notifications) <> 2 THEN
    RAISE EXCEPTION 'FAIL: Owner A must see exactly its own two rows';
  END IF;

  UPDATE public.owner_notifications SET read_at = now()
  WHERE id = 'a0000000-0000-4000-8000-000000000001';
  IF (SELECT count(*) FROM public.owner_notifications WHERE read_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'FAIL: mark one read must affect exactly one owned row';
  END IF;

  UPDATE public.owner_notifications SET read_at = now() WHERE read_at IS NULL;
  IF (SELECT count(*) FROM public.owner_notifications WHERE read_at IS NULL) <> 0 THEN
    RAISE EXCEPTION 'FAIL: mark all must clear only the owner unread rows';
  END IF;

  UPDATE public.owner_notifications SET read_at = now()
  WHERE id = 'b0000000-0000-4000-8000-000000000001';
  IF FOUND THEN RAISE EXCEPTION 'FAIL: Owner A updated Owner B'; END IF;

  BEGIN
    INSERT INTO public.owner_notifications
      (user_id, event_key, kind, title, body, occurred_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', 'forbidden', 'test', 'No', 'No', now());
    RAISE EXCEPTION 'FAIL: authenticated insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM public.owner_notifications;
    RAISE EXCEPTION 'FAIL: authenticated delete unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.owner_notifications
      WHERE user_id = '20000000-0000-4000-8000-000000000002' AND read_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'FAIL: Owner A mark-all changed Owner B';
  END IF;
END $$;

ROLLBACK;
