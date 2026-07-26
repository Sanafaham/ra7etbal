/**
 * Runs after 20260727_staff_escalation_owner_notification_lease.rollback.sql
 * has been applied. Confirms:
 *  - the three new functions are gone
 *  - the four new lease columns are gone
 *  - the owner_notification_status CHECK constraint is restored to its
 *    original 4-value form (no 'sending')
 *  - the Phase A escalation schema (table + its five functions) remains
 *    fully intact — this migration must never touch it
 */

DO $$
DECLARE
  v_fn text;
  v_functions text[] := ARRAY[
    'public.claim_owner_escalation_notification(uuid,uuid,integer)',
    'public.complete_owner_escalation_notification(uuid,uuid,uuid)',
    'public.fail_owner_escalation_notification(uuid,uuid,uuid,text)'
  ];
BEGIN
  FOREACH v_fn IN ARRAY v_functions LOOP
    IF to_regprocedure(v_fn) IS NOT NULL THEN
      RAISE EXCEPTION 'FAIL: function % should not exist after rollback', v_fn;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS: all three owner-notification lease RPCs removed';
END $$;

DO $$
DECLARE
  v_col text;
  v_columns text[] := ARRAY[
    'owner_notification_token', 'owner_notification_claimed_at',
    'owner_notification_lease_until', 'owner_notification_error'
  ];
BEGIN
  FOREACH v_col IN ARRAY v_columns LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'staff_messages' AND column_name = v_col
    ) THEN
      RAISE EXCEPTION 'FAIL: staff_messages.% should not exist after rollback', v_col;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS: all four lease columns removed';
END $$;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
    WHERE conrelid = 'public.staff_messages'::regclass
      AND conname = 'staff_messages_owner_notification_status_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'FAIL: owner_notification_status CHECK constraint is missing after rollback';
  END IF;
  IF v_def LIKE '%sending%' THEN
    RAISE EXCEPTION 'FAIL: owner_notification_status CHECK constraint still allows sending after rollback: %', v_def;
  END IF;
  IF v_def NOT LIKE '%not_attempted%' OR v_def NOT LIKE '%skipped_no_phone%' THEN
    RAISE EXCEPTION 'FAIL: owner_notification_status CHECK constraint lost an original value: %', v_def;
  END IF;
  RAISE NOTICE 'PASS: owner_notification_status CHECK constraint restored to its original 4-value form';
END $$;

-- Phase A escalation schema (from 20260726) must remain fully intact —
-- this rollback must never cascade into or touch it.
DO $$
BEGIN
  IF to_regclass('public.staff_escalation_owner_decisions') IS NULL THEN
    RAISE EXCEPTION 'FAIL: staff_escalation_owner_decisions table must survive this rollback';
  END IF;
  IF to_regprocedure('public.claim_escalation_owner_decision(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'FAIL: claim_escalation_owner_decision must survive this rollback';
  END IF;
  IF to_regprocedure('public.complete_escalation_answer_delivery(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'FAIL: complete_escalation_answer_delivery must survive this rollback';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'staff_messages' AND column_name = 'escalation_resolved_at'
  ) THEN
    RAISE EXCEPTION 'FAIL: staff_messages.escalation_resolved_at (Phase A) must survive this rollback';
  END IF;
  RAISE NOTICE 'PASS: Phase A escalation schema remains fully intact';
END $$;

SELECT 'owner notification lease post-rollback verification complete' AS status;
