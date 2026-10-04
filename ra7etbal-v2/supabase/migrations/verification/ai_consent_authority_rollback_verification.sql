\set ON_ERROR_STOP on

DO $$ BEGIN
  IF to_regclass('public.ai_consent_events') IS NOT NULL THEN
    RAISE EXCEPTION 'Slice 1 table survived rollback';
  END IF;
  IF to_regprocedure('public.grant_ai_consent(uuid,text,text,text,text,text,text[],text,text,text)') IS NOT NULL
     OR to_regprocedure('public.withdraw_ai_consent(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.supersede_ai_consent(uuid,uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.evaluate_ai_consent_authority(uuid,text,text,text,text,text[])') IS NOT NULL THEN
    RAISE EXCEPTION 'Slice 1 function survived rollback';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ai_consent_unrelated_sentinel WHERE id=1) THEN
    RAISE EXCEPTION 'rollback altered unrelated schema/data';
  END IF;
END $$;

SELECT 'ai consent authority bounded rollback verification passed' AS status;
