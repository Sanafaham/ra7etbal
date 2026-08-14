/**
 * Post-rollback verification for
 * 20260813_whatsapp_health_state_phone_number_unique.rollback.sql.
 * Phase 4 of the Carson Engineering Hardening Project.
 *
 * Run after: the full carson_tier1_db_contracts_verification.sql suite
 * (which leaves a canonical binding row in place), then the rollback
 * migration itself. Proves the rollback is safe (removes only the added
 * constraint, existing data untouched) and that the pre-existing
 * UNIQUE(user_id, phone_number_id) constraint — which the rollback's own
 * header promises is untouched — really is still there.
 */

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_health_state_phone_number_id_unique'
      AND conrelid = 'public.whatsapp_health_state'::regclass
  ) THEN
    RAISE EXCEPTION 'FAIL: whatsapp_health_state_phone_number_id_unique should not exist after rollback';
  END IF;
  RAISE NOTICE 'PASS: rollback removed only the phone_number_id-only UNIQUE constraint';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_health_state_user_phone_unique'
      AND conrelid = 'public.whatsapp_health_state'::regclass
  ) THEN
    RAISE EXCEPTION 'FAIL: the pre-existing UNIQUE(user_id, phone_number_id) constraint must survive the rollback untouched';
  END IF;
  RAISE NOTICE 'PASS: pre-existing UNIQUE(user_id, phone_number_id) constraint is untouched by the rollback';
END $$;

-- Existing data (the canonical binding row from the main suite) survives.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_health_state WHERE phone_number_id = 'phone-canonical-1') THEN
    RAISE EXCEPTION 'FAIL: the pre-existing canonical binding row must survive the rollback';
  END IF;
  RAISE NOTICE 'PASS: pre-existing data survives the rollback';
END $$;

-- With the invariant rolled back, the exact contamination shape the
-- forward migration exists to prevent is once again possible — proving the
-- rollback genuinely reverses the protection (not just removing an unused
-- constraint), and confirming the reapply step below is meaningful.
SET ROLE service_role;
INSERT INTO public.whatsapp_health_state (user_id, phone_number_id)
VALUES ('22222222-2222-4222-8222-222222222222', 'phone-canonical-1');
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.whatsapp_health_state WHERE phone_number_id = 'phone-canonical-1') <> 2 THEN
    RAISE EXCEPTION 'FAIL: after rollback, a second user binding the same phone_number_id should now succeed (proves the rollback genuinely removed the DB-level protection)';
  END IF;
  RAISE NOTICE 'PASS: rollback genuinely reverses the canonical-binding protection (two users can bind one number again) — confirms the forward migration''s constraint, not something else, was the actual protection mechanism';
END $$;

-- Clean up the contaminating row before the forward migration is reapplied
-- (matches the real migration's own documented precondition: it must be
-- applied after phantom rows are removed, or it correctly fails rather
-- than silently succeeding on bad data).
DELETE FROM public.whatsapp_health_state
WHERE user_id = '22222222-2222-4222-8222-222222222222' AND phone_number_id = 'phone-canonical-1';

SELECT 'whatsapp_health_state post-rollback verification passed' AS result;
