/**
 * Real-database lifecycle verification for staff_escalation_owner_decisions
 * (Phase A). Runs against a genuine, ephemeral, plain PostgreSQL instance
 * in CI — not Supabase, not production.
 *
 * Rerunnable: every escalation-specific fixture below uses a fresh
 * gen_random_uuid() on each invocation, so this exact script is run twice
 * in CI — once right after the forward migration's first apply, and again
 * after rollback + reapply — with no id collisions between runs.
 *
 * Convention: each numbered check is a self-contained DO block. Success
 * emits a RAISE NOTICE "PASS: ..." line; failure RAISE EXCEPTIONs
 * "FAIL: ..." — run with `psql -v ON_ERROR_STOP=1`, any failure aborts the
 * CI step immediately with the exact failing assertion visible in the log.
 */

CREATE TEMP TABLE _fixture_ids (key text PRIMARY KEY, value uuid);

-- ── Fixtures: two owners (for RLS isolation) + three independent
-- escalations (A: full happy path to delivered_to_staff + RLS + grants;
-- B: fail-then-retry; C: deliberate atomic-failure proof) ────────────────
DO $$
DECLARE
  v_owner_a uuid := gen_random_uuid();
  v_owner_b uuid := gen_random_uuid();
  v_person uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_msg_a uuid := gen_random_uuid();
  v_msg_b uuid := gen_random_uuid();
  v_msg_c uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id) VALUES (v_owner_a), (v_owner_b);
  INSERT INTO public.people (id, user_id, name, phone, is_family)
    VALUES (v_person, v_owner_a, 'Christopher', '+15550000001', false);
  INSERT INTO public.tasks (id, user_id) VALUES (v_task, v_owner_a);

  INSERT INTO public.staff_messages
    (id, user_id, person_id, staff_name, staff_phone, task_id, source,
     inbound_text, classification, processing_status, next_action_owner,
     user_facing_state, owner_attention_required, escalation_reason, received_at)
  VALUES
    (v_msg_a, v_owner_a, v_person, 'Christopher', '+15550000001', v_task, 'whatsapp',
     'The oven is broken, what should I do?', 'blocker', 'completed', 'owner',
     'Needs You', true, 'Oven broken — owner must decide how to proceed', now()),
    (v_msg_b, v_owner_a, v_person, 'Christopher', '+15550000001', v_task, 'whatsapp',
     'Substitute ingredient needed, out of basil.', 'substitution_request', 'completed', 'owner',
     'Needs You', true, 'No basil in stock — approve a substitute?', now()),
    (v_msg_c, v_owner_a, v_person, 'Christopher', '+15550000001', v_task, 'whatsapp',
     'Need a decision on the guest list change.', 'owner_decision_required', 'completed', 'owner',
     'Needs You', true, 'Guest count changed — confirm new headcount', now());

  INSERT INTO _fixture_ids VALUES
    ('owner_a', v_owner_a), ('owner_b', v_owner_b), ('task', v_task),
    ('msg_a', v_msg_a), ('msg_b', v_msg_b), ('msg_c', v_msg_c);

  RAISE NOTICE 'PASS: fixtures created (owner_a=%, msg_a=%, msg_b=%, msg_c=%)', v_owner_a, v_msg_a, v_msg_b, v_msg_c;
END $$;

-- ── 1. idempotent claim ─────────────────────────────────────────────────
DO $$
DECLARE
  v_owner uuid; v_msg uuid; v_task uuid;
  v_row1 public.staff_escalation_owner_decisions;
  v_row2 public.staff_escalation_owner_decisions;
  v_count int;
BEGIN
  SELECT value INTO v_owner FROM _fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_msg FROM _fixture_ids WHERE key = 'msg_a';
  SELECT value INTO v_task FROM _fixture_ids WHERE key = 'task';

  v_row1 := claim_escalation_owner_decision(v_msg, v_owner, v_task);
  v_row2 := claim_escalation_owner_decision(v_msg, v_owner, v_task);

  IF v_row1.id IS DISTINCT FROM v_row2.id THEN
    RAISE EXCEPTION 'FAIL: idempotent claim returned two different ids (% vs %)', v_row1.id, v_row2.id;
  END IF;

  SELECT count(*) INTO v_count FROM public.staff_escalation_owner_decisions WHERE staff_message_id = v_msg;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected exactly 1 escalation row for msg_a, found %', v_count;
  END IF;

  IF v_row1.status <> 'open' THEN
    RAISE EXCEPTION 'FAIL: expected initial status open, got %', v_row1.status;
  END IF;

  INSERT INTO _fixture_ids VALUES ('escalation_a', v_row1.id), ('token_a', v_row1.deep_link_token);
  RAISE NOTICE 'PASS: 1. claim_escalation_owner_decision is idempotent (escalation_a=%)', v_row1.id;
END $$;

-- ── 2. answer once only (double-submit does not overwrite) ─────────────
DO $$
DECLARE
  v_token uuid;
  v_row1 public.staff_escalation_owner_decisions;
  v_row2 public.staff_escalation_owner_decisions;
BEGIN
  SELECT value INTO v_token FROM _fixture_ids WHERE key = 'token_a';

  v_row1 := answer_escalation_owner_decision(v_token, 'Handle it with the gas backup, I approve the extra cost.');
  IF v_row1.status <> 'answered' THEN
    RAISE EXCEPTION 'FAIL: expected status answered after first answer, got %', v_row1.status;
  END IF;
  IF v_row1.owner_reply_text <> 'Handle it with the gas backup, I approve the extra cost.' THEN
    RAISE EXCEPTION 'FAIL: first answer text not stored correctly, got %', v_row1.owner_reply_text;
  END IF;

  -- Double-submit with DIFFERENT text must not overwrite the first answer.
  v_row2 := answer_escalation_owner_decision(v_token, 'A completely different second answer.');
  IF v_row2.owner_reply_text <> v_row1.owner_reply_text THEN
    RAISE EXCEPTION 'FAIL: double-submit overwrote the first answer (now %)', v_row2.owner_reply_text;
  END IF;
  IF v_row2.answered_at <> v_row1.answered_at THEN
    RAISE EXCEPTION 'FAIL: double-submit changed answered_at';
  END IF;

  RAISE NOTICE 'PASS: 2. answer_escalation_owner_decision stores once, double-submit does not overwrite';
END $$;

-- ── 3/4. live lease blocks a second claim; expired lease can be reclaimed ─
DO $$
DECLARE
  v_owner uuid; v_escalation uuid;
  v_claim1 record;
  v_claim2 record;
  v_claim3 record;
BEGIN
  SELECT value INTO v_owner FROM _fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_escalation FROM _fixture_ids WHERE key = 'escalation_a';

  SELECT * INTO v_claim1 FROM claim_escalation_answer_delivery(v_escalation, v_owner, 30);
  IF NOT v_claim1.claimed THEN
    RAISE EXCEPTION 'FAIL: first delivery claim (from answered) should succeed';
  END IF;

  -- Live lease: a second claim attempt right away must NOT succeed.
  SELECT * INTO v_claim2 FROM claim_escalation_answer_delivery(v_escalation, v_owner, 30);
  IF v_claim2.claimed THEN
    RAISE EXCEPTION 'FAIL: a live (non-expired) delivering lease was claimed a second time';
  END IF;
  IF v_claim2.claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: a blocked claim attempt should return NULL claim_token';
  END IF;

  -- Simulate lease expiry (no real-time wait) by moving the lease into the past.
  UPDATE public.staff_escalation_owner_decisions
    SET delivery_lease_until = now() - interval '1 second'
    WHERE id = v_escalation;

  SELECT * INTO v_claim3 FROM claim_escalation_answer_delivery(v_escalation, v_owner, 30);
  IF NOT v_claim3.claimed THEN
    RAISE EXCEPTION 'FAIL: an expired delivering lease should be reclaimable';
  END IF;
  IF v_claim3.claim_token = v_claim1.claim_token THEN
    RAISE EXCEPTION 'FAIL: reclaim must mint a brand-new token, not reuse the stale one';
  END IF;

  INSERT INTO _fixture_ids VALUES ('stale_token_a', v_claim1.claim_token), ('live_token_a', v_claim3.claim_token);
  RAISE NOTICE 'PASS: 3/4. live lease blocks a second claim; expired lease is reclaimable with a fresh token';
END $$;

-- ── 5/7. stale token cannot complete; atomic completion across both tables ─
DO $$
DECLARE
  v_owner uuid; v_escalation uuid; v_msg uuid;
  v_stale_token uuid; v_live_token uuid;
  v_caught boolean := false;
  v_row public.staff_escalation_owner_decisions;
  v_msg_state text; v_resolved_at timestamptz;
BEGIN
  SELECT value INTO v_owner FROM _fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_escalation FROM _fixture_ids WHERE key = 'escalation_a';
  SELECT value INTO v_msg FROM _fixture_ids WHERE key = 'msg_a';
  SELECT value INTO v_stale_token FROM _fixture_ids WHERE key = 'stale_token_a';
  SELECT value INTO v_live_token FROM _fixture_ids WHERE key = 'live_token_a';

  -- Stale (superseded) token must be rejected, not silently accepted.
  BEGIN
    v_row := complete_escalation_answer_delivery(v_escalation, v_owner, v_stale_token);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    IF SQLSTATE <> '40001' THEN
      RAISE EXCEPTION 'FAIL: expected SQLSTATE 40001 (stale_delivery_claim) for stale token, got %', SQLSTATE;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: completing with a stale token should have raised stale_delivery_claim';
  END IF;

  SELECT * INTO v_row FROM public.staff_escalation_owner_decisions WHERE id = v_escalation;
  IF v_row.status <> 'delivering' THEN
    RAISE EXCEPTION 'FAIL: a rejected stale completion must leave status unchanged (delivering), got %', v_row.status;
  END IF;

  -- Now complete with the correct, live token — must succeed atomically.
  v_row := complete_escalation_answer_delivery(v_escalation, v_owner, v_live_token);
  IF v_row.status <> 'delivered_to_staff' THEN
    RAISE EXCEPTION 'FAIL: expected delivered_to_staff after correct completion, got %', v_row.status;
  END IF;
  IF v_row.delivered_at IS NULL THEN
    RAISE EXCEPTION 'FAIL: delivered_at must be set on completion';
  END IF;

  SELECT user_facing_state, escalation_resolved_at INTO v_msg_state, v_resolved_at
    FROM public.staff_messages WHERE id = v_msg;
  IF v_msg_state <> 'Completed' THEN
    RAISE EXCEPTION 'FAIL: linked staff_messages.user_facing_state should be Completed, got %', v_msg_state;
  END IF;
  IF v_resolved_at IS NULL THEN
    RAISE EXCEPTION 'FAIL: staff_messages.escalation_resolved_at must be set on atomic completion';
  END IF;

  RAISE NOTICE 'PASS: 5/7. stale token rejected without side effect; correct token completes both tables atomically';
END $$;

-- ── 6. terminal delivered_to_staff cannot be claimed again ──────────────
DO $$
DECLARE
  v_owner uuid; v_escalation uuid;
  v_claim record;
BEGIN
  SELECT value INTO v_owner FROM _fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_escalation FROM _fixture_ids WHERE key = 'escalation_a';

  SELECT * INTO v_claim FROM claim_escalation_answer_delivery(v_escalation, v_owner, 30);
  IF v_claim.claimed THEN
    RAISE EXCEPTION 'FAIL: a terminal delivered_to_staff row must never be claimable again';
  END IF;

  RAISE NOTICE 'PASS: 6. delivered_to_staff is terminal';
END $$;

-- ── RLS owner isolation (uses escalation_a, owner_a vs owner_b) ─────────
DO $$
DECLARE
  v_owner_a uuid; v_owner_b uuid; v_escalation uuid;
  v_count int;
BEGIN
  SELECT value INTO v_owner_a FROM _fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_owner_b FROM _fixture_ids WHERE key = 'owner_b';
  SELECT value INTO v_escalation FROM _fixture_ids WHERE key = 'escalation_a';

  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_owner_a::text, true);
  SELECT count(*) INTO v_count FROM public.staff_escalation_owner_decisions WHERE id = v_escalation;
  IF v_count <> 1 THEN
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: owner_a should see their own escalation row (saw %)', v_count;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_owner_b::text, true);
  SELECT count(*) INTO v_count FROM public.staff_escalation_owner_decisions WHERE id = v_escalation;
  IF v_count <> 0 THEN
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: owner_b must NOT see owner_a''s escalation row (saw %)', v_count;
  END IF;

  RESET ROLE;
  RAISE NOTICE 'PASS: RLS owner isolation — owner_a sees their row, owner_b sees none';
END $$;

-- ── RPC execution grants: authenticated forbidden, service_role allowed ─
DO $$
DECLARE
  v_owner uuid; v_escalation uuid;
  v_caught boolean := false;
  v_row public.staff_escalation_owner_decisions;
BEGIN
  SELECT value INTO v_owner FROM _fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_escalation FROM _fixture_ids WHERE key = 'escalation_a';

  SET ROLE authenticated;
  BEGIN
    v_row := claim_escalation_owner_decision(gen_random_uuid(), v_owner, NULL);
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;
  RESET ROLE;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: authenticated must NOT be able to execute claim_escalation_owner_decision';
  END IF;

  -- service_role must be able to execute it (grant present, BYPASSRLS covers the table access).
  SET ROLE service_role;
  PERFORM has_function_privilege('service_role', 'public.claim_escalation_owner_decision(uuid,uuid,uuid)', 'EXECUTE');
  RESET ROLE;
  IF NOT has_function_privilege('service_role', 'public.claim_escalation_owner_decision(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: service_role should be granted EXECUTE on claim_escalation_owner_decision';
  END IF;
  IF has_function_privilege('authenticated', 'public.claim_escalation_owner_decision(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated must not be granted EXECUTE on claim_escalation_owner_decision';
  END IF;
  IF has_function_privilege('anon', 'public.claim_escalation_owner_decision(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon must not be granted EXECUTE on claim_escalation_owner_decision';
  END IF;

  RAISE NOTICE 'PASS: RPC execution grants — authenticated/anon forbidden (real permission-denied observed), service_role allowed';
END $$;

-- ── Scenario B: failed delivery keeps Needs You open, then retry succeeds ─
DO $$
DECLARE
  v_owner uuid; v_msg uuid; v_task uuid;
  v_row public.staff_escalation_owner_decisions;
  v_claim1 record;
  v_claim2 record;
  v_msg_state text;
BEGIN
  SELECT value INTO v_owner FROM _fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_msg FROM _fixture_ids WHERE key = 'msg_b';
  SELECT value INTO v_task FROM _fixture_ids WHERE key = 'task';

  v_row := claim_escalation_owner_decision(v_msg, v_owner, v_task);
  v_row := answer_escalation_owner_decision(v_row.deep_link_token, 'Use oregano instead, that is fine.');

  SELECT * INTO v_claim1 FROM claim_escalation_answer_delivery(v_row.id, v_owner, 30);
  IF NOT v_claim1.claimed THEN
    RAISE EXCEPTION 'FAIL: expected to claim delivery for escalation_b';
  END IF;

  v_row := fail_escalation_answer_delivery(v_row.id, v_owner, v_claim1.claim_token, 'meta_delivery_rejected');
  IF v_row.status <> 'failed' THEN
    RAISE EXCEPTION 'FAIL: expected status failed, got %', v_row.status;
  END IF;

  SELECT user_facing_state INTO v_msg_state FROM public.staff_messages WHERE id = v_msg;
  IF v_msg_state <> 'Needs You' THEN
    RAISE EXCEPTION 'FAIL: a failed delivery must leave staff_messages in Needs You, got %', v_msg_state;
  END IF;

  -- Explicit retry: a failed row must be re-claimable.
  SELECT * INTO v_claim2 FROM claim_escalation_answer_delivery(v_row.id, v_owner, 30);
  IF NOT v_claim2.claimed THEN
    RAISE EXCEPTION 'FAIL: a failed delivery row should be explicitly retryable via claim_escalation_answer_delivery';
  END IF;
  IF v_claim2.claim_token = v_claim1.claim_token THEN
    RAISE EXCEPTION 'FAIL: retry must mint a fresh token, not reuse the failed attempt''s token';
  END IF;

  v_row := complete_escalation_answer_delivery(v_row.id, v_owner, v_claim2.claim_token);
  IF v_row.status <> 'delivered_to_staff' THEN
    RAISE EXCEPTION 'FAIL: retried delivery should complete successfully, got %', v_row.status;
  END IF;

  SELECT user_facing_state INTO v_msg_state FROM public.staff_messages WHERE id = v_msg;
  IF v_msg_state <> 'Completed' THEN
    RAISE EXCEPTION 'FAIL: after successful retry, staff_messages should be Completed, got %', v_msg_state;
  END IF;

  RAISE NOTICE 'PASS: failed delivery keeps Needs You open; explicit retry from failed succeeds and resolves atomically';
END $$;

-- ── Scenario C: deliberate real database failure proves atomic rollback ─
DO $$
DECLARE
  v_owner uuid; v_msg uuid; v_task uuid;
  v_row public.staff_escalation_owner_decisions;
  v_claim record;
  v_caught boolean := false;
  v_after public.staff_escalation_owner_decisions;
  v_msg_state text; v_resolved_at timestamptz;
BEGIN
  SELECT value INTO v_owner FROM _fixture_ids WHERE key = 'owner_a';
  SELECT value INTO v_msg FROM _fixture_ids WHERE key = 'msg_c';
  SELECT value INTO v_task FROM _fixture_ids WHERE key = 'task';

  v_row := claim_escalation_owner_decision(v_msg, v_owner, v_task);
  v_row := answer_escalation_owner_decision(v_row.deep_link_token, 'Confirmed: 12 guests, not 10.');
  SELECT * INTO v_claim FROM claim_escalation_answer_delivery(v_row.id, v_owner, 30);
  IF NOT v_claim.claimed THEN
    RAISE EXCEPTION 'FAIL: expected to claim delivery for escalation_c';
  END IF;

  -- Force the SECOND update inside complete_escalation_answer_delivery
  -- (the staff_messages write) to fail with a real constraint violation,
  -- to prove the function's FIRST update (the escalation row) rolls back
  -- with it rather than persisting alone.
  EXECUTE format(
    'ALTER TABLE public.staff_messages ADD CONSTRAINT ck_test_block_msg_c_completion CHECK (id <> %L OR user_facing_state <> ''Completed'')',
    v_msg
  );

  BEGIN
    v_after := complete_escalation_answer_delivery(v_row.id, v_owner, v_claim.claim_token);
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;

  ALTER TABLE public.staff_messages DROP CONSTRAINT ck_test_block_msg_c_completion;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: expected a check_violation from the forced staff_messages constraint';
  END IF;

  SELECT * INTO v_after FROM public.staff_escalation_owner_decisions WHERE id = v_row.id;
  IF v_after.status <> 'delivering' THEN
    RAISE EXCEPTION 'FAIL: atomic rollback failed — escalation row should still be delivering, got %', v_after.status;
  END IF;
  IF v_after.delivery_token <> v_claim.claim_token THEN
    RAISE EXCEPTION 'FAIL: atomic rollback failed — delivery_token should be unchanged after the failed completion';
  END IF;

  SELECT user_facing_state, escalation_resolved_at INTO v_msg_state, v_resolved_at
    FROM public.staff_messages WHERE id = v_msg;
  IF v_msg_state = 'Completed' OR v_resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: atomic rollback failed — staff_messages must not show any effect of the failed completion';
  END IF;

  RAISE NOTICE 'PASS: deliberate real database failure proves complete_escalation_answer_delivery is atomic — a forced second-write failure rolled back the first write too';
END $$;

SELECT 'lifecycle verification complete' AS status;
