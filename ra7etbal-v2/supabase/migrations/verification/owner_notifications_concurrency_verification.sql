CREATE EXTENSION IF NOT EXISTS dblink;

INSERT INTO auth.users (id, email)
VALUES ('30000000-0000-4000-8000-000000000003', 'notification-concurrency@example.test');

BEGIN;
INSERT INTO public.owner_notifications
  (user_id, event_key, kind, title, body, occurred_at)
VALUES
  ('30000000-0000-4000-8000-000000000003', 'reminder_due:concurrent', 'reminder_due', 'Ra7etBal', 'Concurrent', now());

DO $$
DECLARE
  v_conn text := 'host=localhost port=' || current_setting('port') || ' dbname=' || current_database() || ' user=' || current_user;
BEGIN
  PERFORM dblink_connect('notification_concurrent_b', v_conn);
  PERFORM dblink_send_query('notification_concurrent_b', $query$
    WITH inserted AS (
      INSERT INTO public.owner_notifications
        (user_id, event_key, kind, title, body, occurred_at)
      VALUES
        ('30000000-0000-4000-8000-000000000003', 'reminder_due:concurrent', 'reminder_due', 'Ra7etBal', 'Concurrent', now())
      RETURNING id
    ) SELECT id FROM inserted
  $query$);
  PERFORM pg_sleep(0.2);
  IF dblink_is_busy('notification_concurrent_b') = 0 THEN
    RAISE EXCEPTION 'FAIL: concurrent duplicate did not wait on the uncommitted unique-key owner';
  END IF;
END $$;
COMMIT;

DO $$
DECLARE
  v_result record;
  v_error text;
BEGIN
  PERFORM pg_sleep(0.2);
  SELECT * INTO v_result
  FROM dblink_get_result('notification_concurrent_b', false) AS t(id uuid);
  v_error := dblink_error_message('notification_concurrent_b');
  PERFORM dblink_disconnect('notification_concurrent_b');
  IF v_error NOT LIKE '%owner_notifications_user_event_key_key%' THEN
    RAISE EXCEPTION 'FAIL: concurrent loser was not rejected by canonical unique constraint: %', v_error;
  END IF;
  IF (SELECT count(*) FROM public.owner_notifications
      WHERE user_id = '30000000-0000-4000-8000-000000000003'
        AND event_key = 'reminder_due:concurrent') <> 1 THEN
    RAISE EXCEPTION 'FAIL: concurrent creation did not leave exactly one canonical row';
  END IF;
END $$;

DELETE FROM public.owner_notifications WHERE user_id = '30000000-0000-4000-8000-000000000003';
DELETE FROM auth.users WHERE id = '30000000-0000-4000-8000-000000000003';
