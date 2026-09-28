/**
 * Real-PostgreSQL contract verification for
 * 20260929_no_response_superseded_by_proof.sql (Slice 1, Option A).
 *
 * Applied after the staff_escalation_owner_decisions migration chain through
 * 20260928_escalation_review_type_no_response.sql and then 20260929 (see
 * .github/workflows/no-response-supersession-verification.yml).
 *
 * Proves, against the real CHECK, the real partial unique index and the real
 * SECURITY DEFINER RPCs:
 *   S1  same-task uncertain_proof supersedes an open no_response row
 *   S2  same-task substitute_review supersedes an answered (Keep waiting) row,
 *       preserving the owner's recorded answer
 *   S3  a different task of the SAME person is never superseded
 *   S4  a non-proof claim (staff_escalation) for the same task never supersedes
 *   S5  superseded history stays present, unedited except status/updated_at
 *   S6  the superseded row no longer occupies the one-open-per-task slot;
 *       exactly one current review exists
 *   S7  replaying the proof claim returns the same row (no duplicate review)
 *   S8  the owner-notification lease cannot be claimed twice (no duplicate
 *       owner WhatsApp)
 *   S9  a superseded row cannot be answered (neither Ask again nor Keep
 *       waiting) and cannot be claimed for delivery
 *   S10 an in-flight Ask again delivery (status delivering) is superseded; its
 *       stale lease can no longer complete, and it can never be re-claimed
 *   S11 genuinely concurrent proof claim vs no_response sweep claim (two real
 *       connections) converge on exactly one current decision: the proof
 *   S12 existing behaviour without no_response is unchanged
 *
 * PASS lines are RAISE NOTICE; any failure RAISE EXCEPTIONs with
 * ON_ERROR_STOP. Fixtures are removed at the end so the script can run again
 * after rollback + reapply.
 */

\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS dblink;

INSERT INTO auth.users (id) VALUES
  ('c1000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;

INSERT INTO public.people (id, user_id, name, phone) VALUES
  ('c1100000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'Christopher', '+10000000001')
ON CONFLICT DO NOTHING;

-- Five tasks, all delegated to the SAME person, so identity can only come
-- from the task UUID.
INSERT INTO public.tasks (id, user_id, description, status, assigned_to) VALUES
  ('c1200000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000001', 'task A', 'pending', 'Christopher'),
  ('c1200000-0000-4000-8000-00000000000b', 'c1000000-0000-4000-8000-000000000001', 'task B', 'pending', 'Christopher'),
  ('c1200000-0000-4000-8000-00000000000c', 'c1000000-0000-4000-8000-000000000001', 'task C', 'pending', 'Christopher'),
  ('c1200000-0000-4000-8000-00000000000d', 'c1000000-0000-4000-8000-000000000001', 'task D', 'pending', 'Christopher'),
  ('c1200000-0000-4000-8000-00000000000e', 'c1000000-0000-4000-8000-000000000001', 'task E', 'pending', 'Christopher'),
  ('c1200000-0000-4000-8000-00000000000f', 'c1000000-0000-4000-8000-000000000001', 'task F', 'pending', 'Christopher'),
  ('c1200000-0000-4000-8000-000000000010', 'c1000000-0000-4000-8000-000000000001', 'task G', 'pending', 'Christopher')
ON CONFLICT DO NOTHING;

-- ── Schema contract ────────────────────────────────────────────────────────
DO $$
DECLARE v_check text; v_idx text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_check FROM pg_constraint
   WHERE conname = 'staff_escalation_owner_decisions_status_check';
  IF v_check NOT LIKE '%''superseded''%' THEN
    RAISE EXCEPTION 'FAIL: status CHECK must allow superseded (%).', v_check;
  END IF;
  SELECT indexdef INTO v_idx FROM pg_indexes
   WHERE indexname = 'staff_escalation_owner_decisions_task_only_open_idx';
  IF v_idx NOT LIKE '%UNIQUE%' OR v_idx NOT LIKE '%''superseded''%' OR v_idx NOT LIKE '%''failed''%'
     OR v_idx NOT LIKE '%''delivered_to_staff''%' OR v_idx NOT LIKE '%staff_message_id IS NULL%' THEN
    RAISE EXCEPTION 'FAIL: task_only_open index must stay UNIQUE and exclude delivered_to_staff, failed, superseded (%).', v_idx;
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE proname = 'claim_task_escalation_owner_decision') THEN
    RAISE EXCEPTION 'FAIL: claim_task_escalation_owner_decision must stay SECURITY DEFINER';
  END IF;
  RAISE NOTICE 'PASS: schema — CHECK allows superseded; unique index excludes it; RPC still SECURITY DEFINER';
END $$;

-- ── S1 / S5 / S6 / S7: uncertain_proof supersedes open no_response ──────────
DO $$
DECLARE
  u uuid := 'c1000000-0000-4000-8000-000000000001';
  t uuid := 'c1200000-0000-4000-8000-00000000000a';
  nr public.staff_escalation_owner_decisions;
  pr public.staff_escalation_owner_decisions;
  pr2 public.staff_escalation_owner_decisions;
  old public.staff_escalation_owner_decisions;
  v_active int;
BEGIN
  nr := public.claim_task_escalation_owner_decision(t, u, 'no_response', NULL);
  IF nr.review_type <> 'no_response' OR nr.status <> 'open' THEN
    RAISE EXCEPTION 'FAIL: fixture no_response claim returned %/%', nr.review_type, nr.status;
  END IF;
  UPDATE public.staff_escalation_owner_decisions
     SET owner_notification_status = 'sent', owner_notified_at = now()
   WHERE id = nr.id;

  pr := public.claim_task_escalation_owner_decision(t, u, 'uncertain_proof', NULL);
  IF pr.id = nr.id OR pr.review_type <> 'uncertain_proof' OR pr.status <> 'open' THEN
    RAISE EXCEPTION 'FAIL S1: proof claim must create its own open uncertain_proof row (got id=% type=% status=%)', pr.id, pr.review_type, pr.status;
  END IF;

  SELECT * INTO old FROM public.staff_escalation_owner_decisions WHERE id = nr.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL S5: superseded no_response row was deleted'; END IF;
  IF old.status <> 'superseded' OR old.review_type <> 'no_response'
     OR old.owner_notification_status <> 'sent' OR old.owner_notified_at IS NULL
     OR old.owner_reply_text IS NOT NULL OR old.answered_at IS NOT NULL
     OR old.deep_link_token <> nr.deep_link_token THEN
    RAISE EXCEPTION 'FAIL S5: superseded row must keep its evidence and gain no invented facts (%)', row_to_json(old);
  END IF;

  SELECT count(*) INTO v_active FROM public.staff_escalation_owner_decisions
   WHERE task_id = t AND staff_message_id IS NULL
     AND status NOT IN ('delivered_to_staff', 'failed', 'superseded');
  IF v_active <> 1 THEN RAISE EXCEPTION 'FAIL S6: expected exactly one current review, found %', v_active; END IF;

  pr2 := public.claim_task_escalation_owner_decision(t, u, 'uncertain_proof', NULL);
  IF pr2.id <> pr.id THEN RAISE EXCEPTION 'FAIL S7: replayed proof created a second review'; END IF;
  IF (SELECT count(*) FROM public.staff_escalation_owner_decisions WHERE task_id = t) <> 2 THEN
    RAISE EXCEPTION 'FAIL S7: replay changed the row count for the task';
  END IF;
  RAISE NOTICE 'PASS: S1/S5/S6/S7 — same-task uncertain_proof supersedes open no_response; history kept; one current review; replay idempotent';
END $$;

-- ── S8: owner-notification lease cannot be claimed twice ────────────────────
DO $$
DECLARE
  u uuid := 'c1000000-0000-4000-8000-000000000001';
  t uuid := 'c1200000-0000-4000-8000-00000000000a';
  pr_id uuid;
  c1 record; c2 record;
BEGIN
  SELECT id INTO pr_id FROM public.staff_escalation_owner_decisions
   WHERE task_id = t AND review_type = 'uncertain_proof';
  SELECT * INTO c1 FROM public.claim_task_review_owner_notification(pr_id, u, 120);
  SELECT * INTO c2 FROM public.claim_task_review_owner_notification(pr_id, u, 120);
  IF NOT c1.claimed OR c2.claimed THEN
    RAISE EXCEPTION 'FAIL S8: owner notification lease must be claimable exactly once (first=% second=%)', c1.claimed, c2.claimed;
  END IF;
  RAISE NOTICE 'PASS: S8 — replayed proof cannot claim a second owner notification';
END $$;

-- ── S9: superseded row is non-actionable ───────────────────────────────────
DO $$
DECLARE
  u uuid := 'c1000000-0000-4000-8000-000000000001';
  t uuid := 'c1200000-0000-4000-8000-00000000000a';
  old public.staff_escalation_owner_decisions;
  c record;
  v_raised boolean;
  v_choice text;
BEGIN
  SELECT * INTO old FROM public.staff_escalation_owner_decisions
   WHERE task_id = t AND review_type = 'no_response';
  FOREACH v_choice IN ARRAY ARRAY['Ask again', 'Keep waiting'] LOOP
    v_raised := false;
    BEGIN
      PERFORM public.answer_escalation_owner_decision(old.deep_link_token, v_choice, 'app');
    EXCEPTION WHEN OTHERS THEN v_raised := true;
    END;
    IF NOT v_raised THEN RAISE EXCEPTION 'FAIL S9: a superseded row accepted the answer "%"', v_choice; END IF;
  END LOOP;
  SELECT * INTO c FROM public.claim_escalation_answer_delivery(old.id, u, 120);
  IF c.claimed THEN RAISE EXCEPTION 'FAIL S9: a superseded row was claimed for delivery'; END IF;
  IF (SELECT status FROM public.staff_escalation_owner_decisions WHERE id = old.id) <> 'superseded' THEN
    RAISE EXCEPTION 'FAIL S9: superseded row changed state';
  END IF;
  RAISE NOTICE 'PASS: S9 — superseded deep link cannot Ask again or Keep waiting, and cannot be claimed for delivery';
END $$;

-- ── S2: substitute_review supersedes an answered Keep-waiting row ──────────
DO $$
DECLARE
  u uuid := 'c1000000-0000-4000-8000-000000000001';
  t uuid := 'c1200000-0000-4000-8000-00000000000b';
  nr public.staff_escalation_owner_decisions;
  pr public.staff_escalation_owner_decisions;
  old public.staff_escalation_owner_decisions;
BEGIN
  nr := public.claim_task_escalation_owner_decision(t, u, 'no_response', NULL);
  PERFORM public.answer_escalation_owner_decision(nr.deep_link_token, 'Keep waiting', 'app');
  pr := public.claim_task_escalation_owner_decision(t, u, 'substitute_review', NULL);
  SELECT * INTO old FROM public.staff_escalation_owner_decisions WHERE id = nr.id;
  IF pr.review_type <> 'substitute_review' OR pr.id = nr.id THEN
    RAISE EXCEPTION 'FAIL S2: substitute_review must become the current review';
  END IF;
  IF old.status <> 'superseded' OR old.owner_reply_text <> 'Keep waiting' OR old.answered_at IS NULL THEN
    RAISE EXCEPTION 'FAIL S2: the owner''s recorded Keep waiting answer must be preserved (%)', row_to_json(old);
  END IF;
  RAISE NOTICE 'PASS: S2 — same-task substitute_review supersedes a Keep-waiting row and preserves the owner''s answer';
END $$;

-- ── S3 / S4: different task, and non-proof claims, never supersede ──────────
DO $$
DECLARE
  u uuid := 'c1000000-0000-4000-8000-000000000001';
  tc uuid := 'c1200000-0000-4000-8000-00000000000c';
  td uuid := 'c1200000-0000-4000-8000-00000000000d';
  nr public.staff_escalation_owner_decisions;
  other public.staff_escalation_owner_decisions;
  se public.staff_escalation_owner_decisions;
BEGIN
  nr := public.claim_task_escalation_owner_decision(tc, u, 'no_response', NULL);
  other := public.claim_task_escalation_owner_decision(td, u, 'uncertain_proof', NULL);
  IF other.task_id <> td THEN RAISE EXCEPTION 'FAIL S3: proof row bound to the wrong task'; END IF;
  IF (SELECT status FROM public.staff_escalation_owner_decisions WHERE id = nr.id) <> 'open' THEN
    RAISE EXCEPTION 'FAIL S3: proof for a DIFFERENT task of the same person superseded this task''s no_response row';
  END IF;

  se := public.claim_task_escalation_owner_decision(tc, u, 'staff_escalation', NULL);
  IF se.id <> nr.id OR se.review_type <> 'no_response' THEN
    RAISE EXCEPTION 'FAIL S4: a non-proof claim must return the existing no_response row unchanged';
  END IF;
  IF (SELECT status FROM public.staff_escalation_owner_decisions WHERE id = nr.id) <> 'open' THEN
    RAISE EXCEPTION 'FAIL S4: a non-proof claim superseded the no_response row';
  END IF;
  RAISE NOTICE 'PASS: S3/S4 — different task of the same person and non-proof claims never supersede';
END $$;

-- ── S10: in-flight Ask again delivery is superseded; stale lease can't finish ─
DO $$
DECLARE
  u uuid := 'c1000000-0000-4000-8000-000000000001';
  t uuid := 'c1200000-0000-4000-8000-00000000000e';
  nr public.staff_escalation_owner_decisions;
  c record;
  c_again record;
  v_raised boolean := false;
BEGIN
  nr := public.claim_task_escalation_owner_decision(t, u, 'no_response', NULL);
  PERFORM public.answer_escalation_owner_decision(nr.deep_link_token, 'Ask again', 'app');
  SELECT * INTO c FROM public.claim_escalation_answer_delivery(nr.id, u, 120);
  IF NOT c.claimed THEN RAISE EXCEPTION 'FAIL S10 fixture: delivery lease not claimed'; END IF;

  PERFORM public.claim_task_escalation_owner_decision(t, u, 'uncertain_proof', NULL);
  IF (SELECT status FROM public.staff_escalation_owner_decisions WHERE id = nr.id) <> 'superseded' THEN
    RAISE EXCEPTION 'FAIL S10: an in-flight Ask again row must be superseded by newer same-task proof';
  END IF;

  BEGIN
    PERFORM public.complete_escalation_answer_delivery(nr.id, u, c.claim_token, 'wamid.accepted-before-proof');
  EXCEPTION WHEN OTHERS THEN v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL S10: a stale lease on a superseded row must not complete (it would claim delivered_to_staff)';
  END IF;
  SELECT * INTO c_again FROM public.claim_escalation_answer_delivery(nr.id, u, 120);
  IF c_again.claimed THEN RAISE EXCEPTION 'FAIL S10: a superseded row was re-claimed for a second send'; END IF;
  IF (SELECT owner_reply_text FROM public.staff_escalation_owner_decisions WHERE id = nr.id) <> 'Ask again' THEN
    RAISE EXCEPTION 'FAIL S10: the owner''s Ask again answer must be preserved';
  END IF;
  RAISE NOTICE 'PASS: S10 — in-flight Ask again superseded by proof; stale lease cannot complete; no second send; answer preserved';
END $$;

-- ── S11: genuinely concurrent proof claim vs sweep no_response claim ────────
BEGIN;
DO $$
DECLARE
  u uuid := 'c1000000-0000-4000-8000-000000000001';
  t uuid := 'c1200000-0000-4000-8000-00000000000f';
  nr public.staff_escalation_owner_decisions;
BEGIN
  -- Seed a committed open no_response row first (separate connection so it
  -- is committed before the race starts).
  PERFORM dblink_connect('nr_seed', 'host=localhost port=' || current_setting('port') || ' dbname=' || current_database() || ' user=' || current_user);
  PERFORM * FROM dblink('nr_seed', format(
    'SELECT (public.claim_task_escalation_owner_decision(%L::uuid, %L::uuid, %L, NULL)).id::text', t, u, 'no_response'))
    AS seeded(id text);
  PERFORM dblink_disconnect('nr_seed');

  -- Session A (this transaction): proof claim supersedes + inserts, uncommitted.
  PERFORM public.claim_task_escalation_owner_decision(t, u, 'uncertain_proof', NULL);

  -- Session B: a sweep re-claiming no_response for the same task, concurrently.
  PERFORM dblink_connect('nr_race_b', 'host=localhost port=' || current_setting('port') || ' dbname=' || current_database() || ' user=' || current_user);
  PERFORM dblink_send_query('nr_race_b', format(
    'SELECT (public.claim_task_escalation_owner_decision(%L::uuid, %L::uuid, %L, NULL)).review_type', t, u, 'no_response'));
  PERFORM pg_sleep(0.3);
  IF dblink_is_busy('nr_race_b') = 0 THEN
    RAISE EXCEPTION 'FAIL S11: the concurrent sweep claim did not wait on the uncommitted proof claim — the race was not exercised';
  END IF;
END $$;
COMMIT;

DO $$
DECLARE
  t uuid := 'c1200000-0000-4000-8000-00000000000f';
  v_b_type text;
  v_active int;
  v_types text;
BEGIN
  SELECT r INTO v_b_type FROM dblink_get_result('nr_race_b', false) AS x(r text);
  PERFORM dblink_disconnect('nr_race_b');
  SELECT count(*), string_agg(review_type || ':' || status, ',' ORDER BY created_at)
    INTO v_active, v_types
    FROM public.staff_escalation_owner_decisions
   WHERE task_id = t AND staff_message_id IS NULL
     AND status NOT IN ('delivered_to_staff', 'failed', 'superseded');
  IF v_active <> 1 THEN RAISE EXCEPTION 'FAIL S11: expected exactly one current decision after the race, found % (%)', v_active, v_types; END IF;
  IF v_types NOT LIKE 'uncertain_proof:%' THEN
    RAISE EXCEPTION 'FAIL S11: the current decision after the race must be the proof review, got %', v_types;
  END IF;
  IF v_b_type <> 'uncertain_proof' THEN
    RAISE EXCEPTION 'FAIL S11: the losing sweep claim must be handed the proof row (got %), never a fresh no_response', v_b_type;
  END IF;
  IF (SELECT count(*) FROM public.staff_escalation_owner_decisions WHERE task_id = t AND review_type = 'no_response') <> 1 THEN
    RAISE EXCEPTION 'FAIL S11: the race created a second no_response row';
  END IF;
  RAISE NOTICE 'PASS: S11 — concurrent proof vs sweep converge on exactly one current decision (the proof); no second no_response';
END $$;

-- ── S12: behaviour without any no_response row is unchanged ─────────────────
DO $$
DECLARE
  u uuid := 'c1000000-0000-4000-8000-000000000001';
  t uuid := 'c1200000-0000-4000-8000-000000000010';
  a public.staff_escalation_owner_decisions;
  b public.staff_escalation_owner_decisions;
  v_raised boolean := false;
BEGIN
  a := public.claim_task_escalation_owner_decision(t, u, 'substitute_review', NULL);
  b := public.claim_task_escalation_owner_decision(t, u, 'uncertain_proof', NULL);
  IF b.id <> a.id OR b.review_type <> 'substitute_review' THEN
    RAISE EXCEPTION 'FAIL S12: an existing open proof review must still be returned as-is (no supersession between proof types)';
  END IF;
  IF (SELECT count(*) FROM public.staff_escalation_owner_decisions WHERE status = 'superseded' AND task_id = t) <> 0 THEN
    RAISE EXCEPTION 'FAIL S12: supersession touched a non-no_response row';
  END IF;
  BEGIN
    PERFORM public.claim_task_escalation_owner_decision(t, 'c2000000-0000-4000-8000-000000000002', 'uncertain_proof', NULL);
  EXCEPTION WHEN OTHERS THEN v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL S12: cross-account claim must still be refused'; END IF;
  BEGIN
    PERFORM public.claim_task_escalation_owner_decision(t, u, 'not_a_type', NULL);
    RAISE EXCEPTION 'FAIL S12: unknown review type accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  RAISE NOTICE 'PASS: S12 — proof-to-proof, cross-account and unknown-type behaviour unchanged';
END $$;

-- ── Cleanup (ephemeral CI database only) ───────────────────────────────────
DELETE FROM public.staff_escalation_owner_decisions WHERE user_id = 'c1000000-0000-4000-8000-000000000001';
DELETE FROM public.tasks WHERE user_id = 'c1000000-0000-4000-8000-000000000001';
DELETE FROM public.people WHERE user_id = 'c1000000-0000-4000-8000-000000000001';

SELECT 'no_response supersession verification complete' AS result;
