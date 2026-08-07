/**
 * Runs after 20260726_staff_escalation_owner_decisions.rollback.sql has
 * been applied. Confirms:
 *  - the new table, its functions, and its trigger are gone
 *  - the three additive staff_messages columns are gone
 *  - the pre-existing staff_messages row inserted by
 *    01_preexisting_data_fixture.sql (fixed id
 *    00000000-0000-0000-0000-0000000000ac) still exists with its original
 *    content untouched — proving the rollback did not cascade into or
 *    corrupt unrelated staff_messages data
 *  - staff_messages' own pre-existing (20260720/20260724) functions are
 *    still present and callable (existing behavior preserved)
 */

DO $$
BEGIN
  IF to_regclass('public.staff_escalation_owner_decisions') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: staff_escalation_owner_decisions table should not exist after rollback';
  END IF;
  RAISE NOTICE 'PASS: staff_escalation_owner_decisions table removed';
END $$;

DO $$
DECLARE
  v_fn text;
  v_functions text[] := ARRAY[
    'public.claim_escalation_owner_decision(uuid,uuid,uuid)',
    'public.answer_escalation_owner_decision(uuid,text)',
    'public.claim_escalation_answer_delivery(uuid,uuid,integer)',
    'public.complete_escalation_answer_delivery(uuid,uuid,uuid)',
    'public.fail_escalation_answer_delivery(uuid,uuid,uuid,text)',
    'public.set_staff_escalation_owner_decisions_updated_at()'
  ];
BEGIN
  FOREACH v_fn IN ARRAY v_functions LOOP
    IF to_regprocedure(v_fn) IS NOT NULL THEN
      RAISE EXCEPTION 'FAIL: function % should not exist after rollback', v_fn;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS: all five RPCs and the trigger function removed';
END $$;

DO $$
DECLARE
  v_col text;
  v_columns text[] := ARRAY['owner_notification_status', 'owner_notified_at', 'escalation_resolved_at'];
BEGIN
  FOREACH v_col IN ARRAY v_columns LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'staff_messages' AND column_name = v_col
    ) THEN
      RAISE EXCEPTION 'FAIL: staff_messages.% should not exist after rollback', v_col;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS: all three additive staff_messages columns removed';
END $$;

DO $$
DECLARE
  v_classification text; v_state text; v_owner_attention boolean;
BEGIN
  SELECT classification, user_facing_state, owner_attention_required
    INTO v_classification, v_state, v_owner_attention
    FROM public.staff_messages
    WHERE id = '00000000-0000-0000-0000-0000000000ac';

  IF v_classification IS NULL THEN
    RAISE EXCEPTION 'FAIL: pre-existing staff_messages fixture row is missing after rollback';
  END IF;
  IF v_classification <> 'routine_question' OR v_state <> 'Completed' OR v_owner_attention <> false THEN
    RAISE EXCEPTION 'FAIL: pre-existing staff_messages row was altered by rollback (classification=%, state=%, attention=%)',
      v_classification, v_state, v_owner_attention;
  END IF;

  RAISE NOTICE 'PASS: pre-existing staff_messages data preserved unchanged after rollback';
END $$;

DO $$
BEGIN
  IF to_regprocedure('public.claim_staff_message(uuid,uuid,uuid,text,text,text,text,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'FAIL: pre-existing claim_staff_message must survive the rollback untouched';
  END IF;
  IF to_regprocedure('public.complete_staff_message(uuid,uuid,text,text,text,text,boolean,text,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'FAIL: pre-existing complete_staff_message must survive the rollback untouched';
  END IF;
  IF to_regprocedure('public.claim_staff_response_delivery(uuid,uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'FAIL: pre-existing claim_staff_response_delivery must survive the rollback untouched';
  END IF;
  RAISE NOTICE 'PASS: pre-existing staff_messages RPCs untouched by rollback';
END $$;

SELECT 'post-rollback verification complete' AS status;
