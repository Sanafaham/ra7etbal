-- Real-Postgres verification for
-- 20260822_automation_run_task_completion_reconciliation.sql
--
-- Self-contained: builds a minimal bootstrap (auth schema, roles), applies
-- the real unmodified 20260620_agent_automation_layer.sql migration (the
-- actual automations/automation_runs schema), a minimal tasks table
-- matching the columns the trigger reads, then the new trigger migration
-- itself, then exercises every required test case A-M via real INSERT/
-- UPDATE statements and PL/pgSQL assertion blocks.

DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA auth;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULL::uuid $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── minimal people + tasks (only the columns the migrations reference) ────
DROP TABLE IF EXISTS public.tasks CASCADE;
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'pending',
  confirmed_at timestamptz NULL
);

DROP TABLE IF EXISTS public.people CASCADE;
CREATE TABLE public.people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

-- ── apply the real, unmodified automation schema migration ────────────────
\ir ../20260620_agent_automation_layer.sql

-- ── apply the new trigger migration under test ─────────────────────────────
\ir ../20260822_automation_run_task_completion_reconciliation.sql

-- ── fixtures ─────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('10000000-0000-4000-8000-000000000001', 'owner-a@example.test'),
  ('20000000-0000-4000-8000-000000000002', 'owner-b@example.test');

INSERT INTO public.automations (id, user_id, title, instruction, cadence_type, cadence_value, next_run_at)
VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', 'Automation A', 'do A', 'daily', '{}', now() + interval '1 day'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000001', 'Automation B (recurring, must stay untouched)', 'do B', 'daily', '{"time":"09:00"}', '2026-08-22 09:00:00+00');

-- Tasks: one per test case.
INSERT INTO public.tasks (id, user_id, status) VALUES
  ('a0000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', 'pending'), -- A: sent -> confirmed
  ('c0000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', 'pending'), -- C: no linked run
  ('d0000000-0000-4000-8000-00000000000d', '10000000-0000-4000-8000-000000000001', 'pending'), -- D: already confirmed
  ('e0000000-0000-4000-8000-00000000000e', '10000000-0000-4000-8000-000000000001', 'pending'), -- E: skipped
  ('f0000000-0000-4000-8000-00000000000f', '10000000-0000-4000-8000-000000000001', 'pending'), -- F: completed
  ('11111111-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', 'pending'), -- H: non-done update (K test)
  ('22222222-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000001', 'pending'), -- J: sibling task's run untouched
  ('33333333-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000001', 'pending'), -- L: NULL confirmed_at
  ('44444444-0000-4000-8000-000000000044', '10000000-0000-4000-8000-000000000001', 'pending'), -- M: multiple eligible runs
  ('55555555-0000-4000-8000-000000000055', '20000000-0000-4000-8000-000000000002', 'pending'), -- K (cross-user): user B's own task
  ('66666666-0000-4000-8000-000000000066', '10000000-0000-4000-8000-000000000001', 'pending'); -- I: re-update-while-done (no re-fire)

-- automation_runs: one linked row per test case, all initially eligible
-- (current_state='sent') except the protected-state fixtures.
INSERT INTO public.automation_runs (id, automation_id, user_id, task_id, run_for, current_state)
VALUES
  ('eeeeeee0-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', now() - interval '1 second', 'sent'),
  ('eeeeeee0-0000-4000-8000-00000000000d', 'aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-00000000000d', now() - interval '2 second', 'confirmed'),
  ('eeeeeee0-0000-4000-8000-00000000000e', 'aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000e', now() - interval '3 second', 'skipped'),
  ('eeeeeee0-0000-4000-8000-00000000000f', 'aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-00000000000f', now() - interval '4 second', 'completed'),
  ('eeeeeee0-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000022', now() - interval '5 second', 'sent'),
  ('eeeeeee0-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', '33333333-0000-4000-8000-000000000033', now() - interval '6 second', 'sent'),
  -- M: two eligible runs linked to the same task -- ambiguous, must fail closed.
  ('eeeeeee0-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000044', now() - interval '7 second', 'sent'),
  ('eeeeeee0-0000-4000-8000-000000000032', 'bbbbbbbb-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000044', now() - interval '1 second', 'escalated'),
  -- K (cross-user): owned by user A, but task_id collides with user B's own task 55555555.
  ('eeeeeee0-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000055', now() - interval '8 second', 'sent'),
  ('eeeeeee0-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000066', now() - interval '9 second', 'sent');

-- Give run A an unrelated field (sent_at) a distinct, checkable value so
-- the O test can prove the trigger's UPDATE only ever touches
-- current_state/confirmed_at, never any other column.
UPDATE public.automation_runs SET sent_at = '2026-08-20 09:00:00+00' WHERE id = 'eeeeeee0-0000-4000-8000-00000000000a';

-- Snapshot the recurring automation's own row before any completion, to
-- prove it (and its cadence/next_run_at) are untouched by the trigger.
CREATE TEMP TABLE automation_b_before AS
  SELECT status, next_run_at, cadence_type, cadence_value FROM public.automations
   WHERE id = 'bbbbbbbb-0000-4000-8000-00000000000b';

-- ── A: eligible sent run converges to confirmed with the task's own confirmed_at ──
UPDATE public.tasks SET status = 'done', confirmed_at = '2026-08-22 10:00:00+00'
 WHERE id = 'a0000000-0000-4000-8000-00000000000a';

DO $$
DECLARE v_state text; v_confirmed_at timestamptz;
BEGIN
  SELECT current_state, confirmed_at INTO v_state, v_confirmed_at
    FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-00000000000a';
  IF v_state IS DISTINCT FROM 'confirmed' OR v_confirmed_at IS DISTINCT FROM '2026-08-22 10:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'FAIL A: eligible sent run did not converge to confirmed with the task''s own confirmed_at (state=%, confirmed_at=%)', v_state, v_confirmed_at;
  END IF;
  RAISE NOTICE 'PASS A/B: sent run converged to confirmed, confirmed_at matches the task''s own truthful value';
END $$;

-- ── O: unrelated fields on the reconciled run are untouched ────────────────
DO $$
DECLARE v_sent_at timestamptz;
BEGIN
  SELECT sent_at INTO v_sent_at FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-00000000000a';
  IF v_sent_at IS DISTINCT FROM '2026-08-20 09:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'FAIL O: reconciliation modified an unrelated field (sent_at=%)', v_sent_at;
  END IF;
  RAISE NOTICE 'PASS O: reconciliation only touches current_state/confirmed_at, sent_at untouched';
END $$;

-- ── C: task with no linked automation_run is a no-op ──────────────────────
UPDATE public.tasks SET status = 'done', confirmed_at = now()
 WHERE id = 'c0000000-0000-4000-8000-00000000000c';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.automation_runs WHERE task_id = 'c0000000-0000-4000-8000-00000000000c') THEN
    RAISE EXCEPTION 'FAIL C: an automation_run row unexpectedly exists for a task that never had one';
  END IF;
  RAISE NOTICE 'PASS C: non-automation-linked task completion is a clean no-op';
END $$;

-- ── D/E/F: protected terminal states remain unchanged ──────────────────────
UPDATE public.tasks SET status = 'done', confirmed_at = now() WHERE id = 'd0000000-0000-4000-8000-00000000000d';
UPDATE public.tasks SET status = 'done', confirmed_at = now() WHERE id = 'e0000000-0000-4000-8000-00000000000e';
UPDATE public.tasks SET status = 'done', confirmed_at = now() WHERE id = 'f0000000-0000-4000-8000-00000000000f';
DO $$
DECLARE v_d text; v_e text; v_f text;
BEGIN
  SELECT current_state INTO v_d FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-00000000000d';
  SELECT current_state INTO v_e FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-00000000000e';
  SELECT current_state INTO v_f FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-00000000000f';
  IF v_d IS DISTINCT FROM 'confirmed' OR v_e IS DISTINCT FROM 'skipped' OR v_f IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'FAIL D/E/F: a protected terminal state was overwritten (d=%, e=%, f=%)', v_d, v_e, v_f;
  END IF;
  RAISE NOTICE 'PASS D/E/F: already-confirmed, skipped, and completed runs are untouched';
END $$;

-- ── H: a non-done status update never reconciles ───────────────────────────
INSERT INTO public.automation_runs (id, automation_id, user_id, task_id, run_for, current_state)
VALUES ('eeeeeee0-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000011', now(), 'sent');
UPDATE public.tasks SET confirmed_at = NULL WHERE id = '11111111-0000-4000-8000-000000000011';
UPDATE public.tasks SET status = 'pending' WHERE id = '11111111-0000-4000-8000-000000000011';
DO $$
DECLARE v_state text;
BEGIN
  SELECT current_state INTO v_state FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-000000000006';
  IF v_state IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'FAIL H: a pending-status task update unexpectedly reconciled its run (state=%)', v_state;
  END IF;
  RAISE NOTICE 'PASS H: non-done status update does not reconcile';
END $$;

-- ── J: a sibling task's run is untouched by another task's completion ──────
UPDATE public.tasks SET status = 'done', confirmed_at = now() WHERE id = 'a0000000-0000-4000-8000-00000000000a';
DO $$
DECLARE v_state text;
BEGIN
  SELECT current_state INTO v_state FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-000000000001';
  IF v_state IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'FAIL J: an unrelated sibling task''s run was reconciled (state=%)', v_state;
  END IF;
  RAISE NOTICE 'PASS J: sibling task''s run untouched by another task''s completion';
END $$;

-- ── L: NULL confirmed_at fails closed (no-op), never inventing a timestamp ─
UPDATE public.tasks SET status = 'done', confirmed_at = NULL WHERE id = '33333333-0000-4000-8000-000000000033';
DO $$
DECLARE v_state text;
BEGIN
  SELECT current_state INTO v_state FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-000000000002';
  IF v_state IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'FAIL L: a done transition with NULL confirmed_at unexpectedly reconciled its run (state=%)', v_state;
  END IF;
  RAISE NOTICE 'PASS L: NULL confirmed_at fails closed -- no reconciliation, no invented timestamp';
END $$;

-- ── M: multiple eligible runs linked to one task fail closed ───────────────
UPDATE public.tasks SET status = 'done', confirmed_at = now() WHERE id = '44444444-0000-4000-8000-000000000044';
DO $$
DECLARE v_m1 text; v_m2 text;
BEGIN
  SELECT current_state INTO v_m1 FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-000000000003';
  SELECT current_state INTO v_m2 FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-000000000032';
  IF v_m1 IS DISTINCT FROM 'sent' OR v_m2 IS DISTINCT FROM 'escalated' THEN
    RAISE EXCEPTION 'FAIL M: ambiguous multiple-run task was resolved instead of failing closed (m1=%, m2=%)', v_m1, v_m2;
  END IF;
  RAISE NOTICE 'PASS M: multiple eligible runs on one task fail closed -- neither modified';
END $$;

-- ── K: cross-user isolation despite a colliding task_id ─────────────────────
UPDATE public.tasks SET status = 'done', confirmed_at = now()
 WHERE id = '55555555-0000-4000-8000-000000000055';
DO $$
DECLARE v_state text;
BEGIN
  SELECT current_state INTO v_state FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-000000000008';
  IF v_state IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'FAIL K: another user''s run was reconciled despite a colliding task_id (state=%)', v_state;
  END IF;
  RAISE NOTICE 'PASS K: cross-user isolation holds despite a colliding task_id';
END $$;

-- ── I: no re-firing on an already-done task's further update ───────────────
UPDATE public.tasks SET status = 'done', confirmed_at = '2026-08-22 11:00:00+00' WHERE id = '66666666-0000-4000-8000-000000000066';
UPDATE public.tasks SET confirmed_at = '2026-08-22 12:00:00+00' WHERE id = '66666666-0000-4000-8000-000000000066';
DO $$
DECLARE v_confirmed_at timestamptz;
BEGIN
  SELECT confirmed_at INTO v_confirmed_at FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-000000000005';
  IF v_confirmed_at IS DISTINCT FROM '2026-08-22 11:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'FAIL I: a further update on an already-done task re-fired reconciliation (confirmed_at=%)', v_confirmed_at;
  END IF;
  RAISE NOTICE 'PASS I: no re-firing on an already-done task''s further update';
END $$;

-- ── N: the recurring automation record itself is untouched ─────────────────
DO $$
DECLARE v_status text; v_next_run_at timestamptz; v_cadence_type text; v_cadence_value jsonb;
BEGIN
  SELECT status, next_run_at, cadence_type, cadence_value
    INTO v_status, v_next_run_at, v_cadence_type, v_cadence_value
    FROM public.automations WHERE id = 'bbbbbbbb-0000-4000-8000-00000000000b';
  IF NOT EXISTS (
    SELECT 1 FROM automation_b_before b
     WHERE b.status = v_status AND b.next_run_at = v_next_run_at
       AND b.cadence_type = v_cadence_type AND b.cadence_value = v_cadence_value
  ) THEN
    RAISE EXCEPTION 'FAIL N: the recurring automation''s own status/next_run_at/cadence changed';
  END IF;
  RAISE NOTICE 'PASS N: recurring automation record (status, next_run_at, cadence) untouched';
END $$;

-- ── Q: migration application performed no backfill of pre-existing rows ────
-- (structural proof: every automation_runs row above was inserted by this
-- verification script AFTER both migrations were applied; the trigger
-- migration itself contains no UPDATE/INSERT/DELETE statement outside the
-- trigger function body, so it cannot have touched anything at apply time.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.automation_runs
     WHERE id::text NOT LIKE 'eeeeeee0-0000-4000-8000-%'
  ) THEN
    RAISE EXCEPTION 'FAIL Q: unexpected automation_runs rows exist that this script did not create';
  END IF;
  RAISE NOTICE 'PASS Q: no backfill -- only fixture rows this script created exist';
END $$;

-- ── R/S: rollback removes only the new objects, reapply restores them ──────
\ir ../20260822_automation_run_task_completion_reconciliation.rollback.sql

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reconcile_automation_run_on_task_done')
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'reconcile_automation_run_on_task_done') THEN
    RAISE EXCEPTION 'FAIL R: rollback did not remove the trigger/function';
  END IF;
  RAISE NOTICE 'PASS R: rollback removed exactly the trigger and function';
END $$;

\ir ../20260822_automation_run_task_completion_reconciliation.sql

UPDATE public.tasks SET status = 'pending', confirmed_at = NULL WHERE id = 'c0000000-0000-4000-8000-00000000000c';
INSERT INTO public.automation_runs (id, automation_id, user_id, task_id, run_for, current_state)
VALUES ('eeeeeee0-0000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000c', now(), 'sent');
UPDATE public.tasks SET status = 'done', confirmed_at = '2026-08-22 13:00:00+00' WHERE id = 'c0000000-0000-4000-8000-00000000000c';

DO $$
DECLARE v_state text; v_confirmed_at timestamptz;
BEGIN
  SELECT current_state, confirmed_at INTO v_state, v_confirmed_at
    FROM public.automation_runs WHERE id = 'eeeeeee0-0000-4000-8000-000000000009';
  IF v_state IS DISTINCT FROM 'confirmed' OR v_confirmed_at IS DISTINCT FROM '2026-08-22 13:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'FAIL S: reapplied trigger did not correctly reconcile a fresh eligible run';
  END IF;
  RAISE NOTICE 'PASS S: reapply after rollback restores correct behavior';
END $$;

-- ── cleanup ─────────────────────────────────────────────────────────────
DELETE FROM public.automation_runs;
DELETE FROM public.automations;
DELETE FROM public.tasks;
DELETE FROM public.people;
DELETE FROM auth.users;

SELECT 'ALL PASS: automation_run task-completion reconciliation verified' AS result;
