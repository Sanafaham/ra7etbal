/**
 * Real-Postgres verification for
 * 20260821_owner_notifications_task_completion_reconciliation.sql.
 *
 * Self-contained bootstrap (auth schema, roles, auth.uid(), a public.tasks
 * table carrying the columns the trigger actually reads/writes) — the
 * real, unmodified owner_notifications migrations
 * (20260811231000_owner_notifications.sql,
 * 20260814180000_owner_notifications_soft_dismiss.sql) build the real
 * schema under test; only the trigger migration itself is exercised for
 * behavior. Matches the existing precedent
 * (push-subscription-installation-identity-verification.yml's own
 * self-contained-bootstrap note) for a table family with no full Tier 1
 * bootstrap chain to build on.
 *
 * Proves, against a genuine ephemeral PostgreSQL instance:
 *   A. task_escalation dismissed when its task completes
 *   B. reminder_due dismissed when its task completes
 *   C. every other actionable kind dismissed
 *   D. task_completed left untouched
 *   E. routine_message_sent left untouched
 *   F. an unknown/future kind left untouched (positive-allowlist fail-safe)
 *   G. an already-dismissed actionable notification keeps its original
 *      dismissed_at (never overwritten)
 *   H. a notification for a DIFFERENT task is untouched
 *   I. a notification for a DIFFERENT user is untouched even when
 *      target_id collides with the resolving task's id
 *   J. updating an already-done task again does not re-fire reconciliation
 *   K. a non-'done' status update never reconciles anything
 *   L. dismissed_at uses the task's own confirmed_at, not an invented time
 */

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Minimal self-contained bootstrap ────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE TABLE IF NOT EXISTS public.tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending',
  confirmed_at timestamptz NULL
);

-- Two real owner accounts, to prove tenant isolation with genuinely
-- distinct users rather than a single stand-in.
INSERT INTO auth.users (id, email) VALUES
  ('10000000-0000-4000-8000-000000000001', 'owner-a@example.test'),
  ('20000000-0000-4000-8000-000000000002', 'owner-b@example.test');

\set ON_ERROR_STOP on

-- ── Apply the real, unmodified owner_notifications schema, then the ────────
-- ── trigger migration under test ────────────────────────────────────────

\ir ../20260811231000_owner_notifications.sql
\ir ../20260814180000_owner_notifications_soft_dismiss.sql
\ir ../20260821_owner_notifications_task_completion_reconciliation.sql

-- ── Fixtures ─────────────────────────────────────────────────────────────

INSERT INTO public.tasks (id, user_id, status) VALUES
  ('a0000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', 'pending'), -- A: task_escalation
  ('b0000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000001', 'pending'), -- B: reminder_due
  ('c0000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', 'pending'), -- C1: routine_reminder
  ('c0000000-0000-4000-8000-00000000000d', '10000000-0000-4000-8000-000000000001', 'pending'), -- C2: task_review_followup
  ('c0000000-0000-4000-8000-00000000000e', '10000000-0000-4000-8000-000000000001', 'pending'), -- C3: automation_reminder
  ('d0000000-0000-4000-8000-00000000000d', '10000000-0000-4000-8000-000000000001', 'pending'), -- D: task_completed source task
  ('e0000000-0000-4000-8000-00000000000e', '10000000-0000-4000-8000-000000000001', 'pending'), -- E: routine_message_sent source task
  ('f0000000-0000-4000-8000-00000000000f', '10000000-0000-4000-8000-000000000001', 'pending'), -- F: unknown kind source task
  ('11111111-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', 'pending'), -- G: already-dismissed
  ('22222222-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000001', 'pending'), -- H: sibling task (must stay untouched)
  ('33333333-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000001', 'pending'), -- J: re-update-while-done
  ('44444444-0000-4000-8000-000000000044', '10000000-0000-4000-8000-000000000001', 'pending'); -- K: non-done update

-- I: a second user's own task, sharing NO real target_id with user A's
-- notifications above — isolation is proven by directly inserting a
-- corrupt-data notification below whose target_id collides with a real
-- user-A task id but whose user_id belongs to user B.
INSERT INTO public.tasks (id, user_id, status) VALUES
  ('55555555-0000-4000-8000-000000000055', '20000000-0000-4000-8000-000000000002', 'pending');

INSERT INTO public.owner_notifications
  (user_id, event_key, kind, title, body, occurred_at, target_type, target_id) VALUES
  ('10000000-0000-4000-8000-000000000001', 'task_escalation:a', 'task_escalation', 'Ra7etBal · Action needed', 'A', now(), 'task', 'a0000000-0000-4000-8000-00000000000a'),
  ('10000000-0000-4000-8000-000000000001', 'reminder_due:b',    'reminder_due',    'Ra7etBal',                'B', now(), 'task', 'b0000000-0000-4000-8000-00000000000b'),
  ('10000000-0000-4000-8000-000000000001', 'routine_reminder:c1', 'routine_reminder',    'Ra7etBal · Reminder', 'C1', now(), 'task', 'c0000000-0000-4000-8000-00000000000c'),
  ('10000000-0000-4000-8000-000000000001', 'task_review_followup:c2', 'task_review_followup', 'Ra7etBal',       'C2', now(), 'task', 'c0000000-0000-4000-8000-00000000000d'),
  ('10000000-0000-4000-8000-000000000001', 'automation_run:c3', 'automation_reminder', 'Ra7etBal · Reminder',  'C3', now(), 'task', 'c0000000-0000-4000-8000-00000000000e'),
  -- D: an ALREADY-EXISTING task_completed row must never be dismissed by
  -- the trigger — it is history, not an open ask, even though it shares
  -- target_id with the task that is about to complete.
  ('10000000-0000-4000-8000-000000000001', 'task_completed:d',  'task_completed',  'Ra7etBal',                'D done', now(), 'task', 'd0000000-0000-4000-8000-00000000000d'),
  -- E: routine_message_sent, no target — untouched regardless.
  ('10000000-0000-4000-8000-000000000001', 'routine_message:e', 'routine_message_sent', 'Ra7etBal',            'msg sent', now(), NULL, NULL),
  -- F: an unknown/future kind sharing target_id with the task that
  -- completes — must be left alone by the positive allowlist.
  ('10000000-0000-4000-8000-000000000001', 'future_kind:f', 'some_future_kind', 'Ra7etBal', 'F', now(), 'task', 'f0000000-0000-4000-8000-00000000000f'),
  -- G: an actionable kind that was ALREADY dismissed 10 minutes ago —
  -- the trigger must not overwrite its original dismissed_at.
  ('10000000-0000-4000-8000-000000000001', 'task_escalation:g', 'task_escalation', 'Ra7etBal · Action needed', 'G', now(), 'task', '11111111-0000-4000-8000-000000000011'),
  -- H: actionable notification for the SIBLING task, never touched when a
  -- DIFFERENT task (H's neighbour) completes.
  ('10000000-0000-4000-8000-000000000001', 'task_escalation:h', 'task_escalation', 'Ra7etBal · Action needed', 'H (sibling, must stay open)', now(), 'task', '22222222-0000-4000-8000-000000000022'),
  -- I: corrupt/colliding data — a notification claiming target_id equal
  -- to task A's id, but owned by user B. Proves the trigger's explicit
  -- user_id = NEW.user_id guard, independent of RLS.
  ('20000000-0000-4000-8000-000000000002', 'task_escalation:i-corrupt', 'task_escalation', 'Ra7etBal · Action needed', 'I (other user, must stay open)', now(), 'task', 'a0000000-0000-4000-8000-00000000000a'),
  -- J: actionable notification for the task that will be marked done,
  -- then updated again while already done.
  ('10000000-0000-4000-8000-000000000001', 'task_escalation:j', 'task_escalation', 'Ra7etBal · Action needed', 'J', now(), 'task', '33333333-0000-4000-8000-000000000033'),
  -- K: actionable notification for the task that will receive a non-done
  -- status update only.
  ('10000000-0000-4000-8000-000000000001', 'task_escalation:k', 'task_escalation', 'Ra7etBal · Action needed', 'K', now(), 'task', '44444444-0000-4000-8000-000000000044');

UPDATE public.owner_notifications
SET dismissed_at = '2025-06-01 00:00:00+00'
WHERE event_key = 'task_escalation:g';

-- ── A/B/C/L: actionable kinds dismissed with the task's own truthful ──────
-- ── confirmed_at, not an invented time ─────────────────────────────────

UPDATE public.tasks SET status = 'done', confirmed_at = '2026-01-01 00:00:00+00'
WHERE id = 'a0000000-0000-4000-8000-00000000000a';

UPDATE public.tasks SET status = 'done', confirmed_at = now()
WHERE id IN (
  'b0000000-0000-4000-8000-00000000000b',
  'c0000000-0000-4000-8000-00000000000c',
  'c0000000-0000-4000-8000-00000000000d',
  'c0000000-0000-4000-8000-00000000000e',
  'd0000000-0000-4000-8000-00000000000d',
  'e0000000-0000-4000-8000-00000000000e',
  'f0000000-0000-4000-8000-00000000000f',
  '11111111-0000-4000-8000-000000000011',
  '33333333-0000-4000-8000-000000000033'
);

DO $$
BEGIN
  -- A
  IF NOT EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'task_escalation:a' AND dismissed_at = '2026-01-01 00:00:00+00') THEN
    RAISE EXCEPTION 'FAIL A: task_escalation not dismissed with the task''s own confirmed_at';
  END IF;
  -- B
  IF NOT EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'reminder_due:b' AND dismissed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL B: reminder_due not dismissed';
  END IF;
  -- C: every other actionable kind
  IF NOT EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'routine_reminder:c1' AND dismissed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL C1: routine_reminder not dismissed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'task_review_followup:c2' AND dismissed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL C2: task_review_followup not dismissed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'automation_run:c3' AND dismissed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL C3: automation_reminder not dismissed';
  END IF;
  RAISE NOTICE 'PASS A/B/C/L: all actionable kinds dismissed, task-A used its own truthful confirmed_at';
END $$;

-- ── D/E/F: historical/informational and unknown kinds never touched ──────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'task_completed:d' AND dismissed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL D: task_completed was dismissed — historical record must never be touched';
  END IF;
  IF EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'routine_message:e' AND dismissed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL E: routine_message_sent was dismissed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'future_kind:f' AND dismissed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL F: an unknown/future kind was dismissed — allowlist is not fail-safe';
  END IF;
  RAISE NOTICE 'PASS D/E/F: historical and unknown-kind notifications untouched';
END $$;

-- ── G: an already-dismissed actionable notification keeps its original ───
-- ── dismissed_at — never overwritten ─────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.owner_notifications
    WHERE event_key = 'task_escalation:g' AND dismissed_at = '2025-06-01 00:00:00+00'
  ) THEN
    RAISE EXCEPTION 'FAIL G: already-dismissed notification''s original dismissed_at was overwritten';
  END IF;
  RAISE NOTICE 'PASS G: already-dismissed notification preserved its original timestamp';
END $$;

-- ── H: a sibling task's notification is untouched by any of the above ────
-- ── completions (proven by construction — no completion above targeted ───
-- ── H's task id) ──────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'task_escalation:h' AND dismissed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL H: a different task''s notification was dismissed';
  END IF;
  RAISE NOTICE 'PASS H: sibling task''s notification untouched';
END $$;

-- ── I: cross-user isolation — task A completed above with a corrupt- ─────
-- ── data notification claiming the same target_id but owned by user B ───

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'task_escalation:i-corrupt' AND dismissed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL I: cross-account dismissal occurred despite matching target_id';
  END IF;
  RAISE NOTICE 'PASS I: another user''s notification untouched despite a colliding target_id';
END $$;

-- ── J: updating an already-done task again must not re-fire ──────────────
-- ── reconciliation ────────────────────────────────────────────────────────

INSERT INTO public.owner_notifications
  (user_id, event_key, kind, title, body, occurred_at, target_type, target_id)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'task_escalation:j-post-done', 'task_escalation', 'Ra7etBal · Action needed', 'created after J was already done', now(), 'task', '33333333-0000-4000-8000-000000000033');

UPDATE public.tasks SET confirmed_at = now() WHERE id = '33333333-0000-4000-8000-000000000033';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'task_escalation:j-post-done' AND dismissed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL J: reconciliation re-fired on a same-status (done -> done) update';
  END IF;
  RAISE NOTICE 'PASS J: no re-firing on an already-done task''s further update';
END $$;

-- ── K: a non-'done' status update never reconciles anything ──────────────

UPDATE public.tasks SET confirmed_at = now() WHERE id = '44444444-0000-4000-8000-000000000044';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.owner_notifications WHERE event_key = 'task_escalation:k' AND dismissed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL K: a non-done status update triggered reconciliation';
  END IF;
  RAISE NOTICE 'PASS K: pending-task update did not reconcile anything';
END $$;

DELETE FROM public.owner_notifications;
DELETE FROM public.tasks;
DELETE FROM auth.users WHERE id IN ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002');

SELECT 'ALL PASS: owner_notifications task-completion reconciliation verified' AS result;
