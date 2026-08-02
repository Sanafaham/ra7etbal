/**
 * Real-database lifecycle verification for the owner-notification lease
 * (claim_owner_escalation_notification / complete_.../fail_...).
 *
 * Rerunnable: every fixture uses a fresh gen_random_uuid() each
 * invocation, so this script can run once after the first forward-apply
 * and again after rollback + reapply with no id collisions.
 */

CREATE TEMP TABLE IF NOT EXISTS _lease_fixture_ids (key text PRIMARY KEY, value uuid);
DELETE FROM _lease_fixture_ids;

DO $$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_person uuid := gen_random_uuid();
  v_msg_a uuid := gen_random_uuid();
  v_msg_b uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id) VALUES (v_owner);
  INSERT INTO public.people (id, user_id, name, phone, is_family)
    VALUES (v_person, v_owner, 'Christopher', '+15550000001', false);
  INSERT INTO public.staff_messages
    (id, user_id, person_id, staff_name, staff_phone, source,
     inbound_text, classification, processing_status, next_action_owner,
     user_facing_state, owner_attention_required, escalation_reason, received_at)
  VALUES
    (v_msg_a, v_owner, v_person, 'Christopher', '+15550000001', 'whatsapp',
     'Oven broken', 'blocker', 'completed', 'owner', 'Needs You', true, 'Oven broken', now()),
    (v_msg_b, v_owner, v_person, 'Christopher', '+15550000001', 'whatsapp',
     'Substitution needed', 'substitution_request', 'completed', 'owner', 'Needs You', true, 'No basil', now());

  INSERT INTO _lease_fixture_ids VALUES ('owner', v_owner), ('msg_a', v_msg_a), ('msg_b', v_msg_b);
  RAISE NOTICE 'PASS: lease fixtures created (msg_a=%, msg_b=%)', v_msg_a, v_msg_b;
END $$;

-- 1. first claim succeeds
DO $$
DECLARE
  v_owner uuid; v_msg uuid;
  v_claim1 record;
BEGIN
  SELECT value INTO v_owner FROM _lease_fixture_ids WHERE key = 'owner';
  SELECT value INTO v_msg FROM _lease_fixture_ids WHERE key = 'msg_a';

  SELECT * INTO v_claim1 FROM claim_owner_escalation_notification(v_msg, v_owner, 30);
  IF NOT v_claim1.claimed THEN
    RAISE EXCEPTION 'FAIL: first claim (from not_attempted) should succeed';
  END IF;
  IF v_claim1.notification_status <> 'sending' THEN
    RAISE EXCEPTION 'FAIL: expected notification_status sending, got %', v_claim1.notification_status;
  END IF;

  INSERT INTO _lease_fixture_ids VALUES ('token_a1', v_claim1.claim_token);
  RAISE NOTICE 'PASS: 1. first claim succeeds (token=%)', v_claim1.claim_token;
END $$;

-- 2. concurrent/immediate second claim is blocked
DO $$
DECLARE
  v_owner uuid; v_msg uuid;
  v_claim2 record;
BEGIN
  SELECT value INTO v_owner FROM _lease_fixture_ids WHERE key = 'owner';
  SELECT value INTO v_msg FROM _lease_fixture_ids WHERE key = 'msg_a';

  SELECT * INTO v_claim2 FROM claim_owner_escalation_notification(v_msg, v_owner, 30);
  IF v_claim2.claimed THEN
    RAISE EXCEPTION 'FAIL: a live (non-expired) sending lease was claimed a second time';
  END IF;
  IF v_claim2.claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: a blocked claim attempt should return NULL claim_token';
  END IF;
  IF v_claim2.notification_status <> 'sending' THEN
    RAISE EXCEPTION 'FAIL: blocked claim should report the true current status sending, got %', v_claim2.notification_status;
  END IF;

  RAISE NOTICE 'PASS: 2. concurrent/immediate second claim is blocked';
END $$;

-- stale complete token rejected; correct token completes with sent + owner_notified_at
DO $$
DECLARE
  v_owner uuid; v_msg uuid; v_token_a1 uuid;
  v_caught boolean := false;
  v_row public.staff_messages;
BEGIN
  SELECT value INTO v_owner FROM _lease_fixture_ids WHERE key = 'owner';
  SELECT value INTO v_msg FROM _lease_fixture_ids WHERE key = 'msg_a';
  SELECT value INTO v_token_a1 FROM _lease_fixture_ids WHERE key = 'token_a1';

  -- A fabricated stale token (not the live one) must be rejected.
  BEGIN
    v_row := complete_owner_escalation_notification(v_msg, v_owner, gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    IF SQLSTATE <> '40001' THEN
      RAISE EXCEPTION 'FAIL: expected SQLSTATE 40001 for stale complete token, got %', SQLSTATE;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: completing with a fabricated stale token should have raised stale_notification_claim';
  END IF;
  RAISE NOTICE 'PASS: stale complete token rejected';

  -- Correct, live token completes successfully.
  v_row := complete_owner_escalation_notification(v_msg, v_owner, v_token_a1);
  IF v_row.owner_notification_status <> 'sent' THEN
    RAISE EXCEPTION 'FAIL: expected owner_notification_status sent, got %', v_row.owner_notification_status;
  END IF;
  IF v_row.owner_notified_at IS NULL THEN
    RAISE EXCEPTION 'FAIL: owner_notified_at must be set on successful completion';
  END IF;
  IF v_row.owner_notification_token IS NOT NULL OR v_row.owner_notification_lease_until IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: lease fields must be cleared after completion';
  END IF;

  RAISE NOTICE 'PASS: successful completion records sent and owner_notified_at';
END $$;

-- 3. sent is terminal
DO $$
DECLARE
  v_owner uuid; v_msg uuid;
  v_claim record;
BEGIN
  SELECT value INTO v_owner FROM _lease_fixture_ids WHERE key = 'owner';
  SELECT value INTO v_msg FROM _lease_fixture_ids WHERE key = 'msg_a';

  SELECT * INTO v_claim FROM claim_owner_escalation_notification(v_msg, v_owner, 30);
  IF v_claim.claimed THEN
    RAISE EXCEPTION 'FAIL: a terminal sent notification must never be claimable again';
  END IF;
  IF v_claim.notification_status <> 'sent' THEN
    RAISE EXCEPTION 'FAIL: expected notification_status sent, got %', v_claim.notification_status;
  END IF;

  RAISE NOTICE 'PASS: 3. sent is terminal';
END $$;

-- 4/5/stale-fail-token: failed is retryable; expired sending lease is reclaimable; stale fail token rejected
DO $$
DECLARE
  v_owner uuid; v_msg uuid;
  v_claim1 record; v_claim2 record; v_claim3 record;
  v_caught boolean := false;
  v_row public.staff_messages;
BEGIN
  SELECT value INTO v_owner FROM _lease_fixture_ids WHERE key = 'owner';
  SELECT value INTO v_msg FROM _lease_fixture_ids WHERE key = 'msg_b';

  SELECT * INTO v_claim1 FROM claim_owner_escalation_notification(v_msg, v_owner, 30);
  IF NOT v_claim1.claimed THEN
    RAISE EXCEPTION 'FAIL: first claim on msg_b should succeed';
  END IF;

  -- Fail it with a fabricated stale token first — must be rejected, real state untouched.
  BEGIN
    v_row := fail_owner_escalation_notification(v_msg, v_owner, gen_random_uuid(), 'irrelevant');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    IF SQLSTATE <> '40001' THEN
      RAISE EXCEPTION 'FAIL: expected SQLSTATE 40001 for stale fail token, got %', SQLSTATE;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: failing with a fabricated stale token should have raised stale_notification_claim';
  END IF;
  RAISE NOTICE 'PASS: stale fail token rejected';

  -- Fail it for real with the live token.
  v_row := fail_owner_escalation_notification(v_msg, v_owner, v_claim1.claim_token, 'meta_rejected: 131047');
  IF v_row.owner_notification_status <> 'failed' THEN
    RAISE EXCEPTION 'FAIL: expected owner_notification_status failed, got %', v_row.owner_notification_status;
  END IF;
  IF v_row.owner_notification_error IS NULL OR v_row.owner_notification_error NOT LIKE '%131047%' THEN
    RAISE EXCEPTION 'FAIL: owner_notification_error must record the failure reason, got %', v_row.owner_notification_error;
  END IF;
  RAISE NOTICE 'PASS: failed completion records failed and error';

  -- 4. failed is explicitly retryable.
  SELECT * INTO v_claim2 FROM claim_owner_escalation_notification(v_msg, v_owner, 30);
  IF NOT v_claim2.claimed THEN
    RAISE EXCEPTION 'FAIL: a failed notification must be explicitly retryable';
  END IF;
  IF v_claim2.claim_token = v_claim1.claim_token THEN
    RAISE EXCEPTION 'FAIL: retry must mint a fresh token, not reuse the failed attempt''s token';
  END IF;
  RAISE NOTICE 'PASS: 4. failed is retryable with a fresh token';

  -- 5. expired sending lease is reclaimable (simulate expiry, no real-time wait).
  UPDATE public.staff_messages SET owner_notification_lease_until = now() - interval '1 second' WHERE id = v_msg;
  SELECT * INTO v_claim3 FROM claim_owner_escalation_notification(v_msg, v_owner, 30);
  IF NOT v_claim3.claimed THEN
    RAISE EXCEPTION 'FAIL: an expired sending lease should be reclaimable';
  END IF;
  IF v_claim3.claim_token = v_claim2.claim_token THEN
    RAISE EXCEPTION 'FAIL: reclaim must mint a brand-new token, not reuse the stale one';
  END IF;
  RAISE NOTICE 'PASS: 5. expired sending lease is reclaimable with a fresh token';
END $$;

SELECT 'owner notification lease verification complete' AS status;
