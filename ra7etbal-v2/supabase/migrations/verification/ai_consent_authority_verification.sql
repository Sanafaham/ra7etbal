\set ON_ERROR_STOP on

-- Anonymous users can neither read evidence nor call owner RPCs.
SET ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.ai_consent_events; RAISE EXCEPTION 'anonymous read unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.grant_ai_consent('eeeeeeee-0000-4000-8000-000000000001','ai-v1','disclosure-v1','carson_reasoning','provider','anthropic',ARRAY['user_text'],'settings','text','explicit_accept');
    RAISE EXCEPTION 'anonymous grant unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.withdraw_ai_consent('eeeeeeee-0000-4000-8000-000000000002','eeeeeeee-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'anonymous withdrawal unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

-- Owner A grants exact authority. Ownership comes only from auth.uid().
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SELECT public.grant_ai_consent('aaaaaaaa-0000-4000-8000-000000000001','ai-v1','disclosure-v1','carson_reasoning','provider','anthropic',ARRAY['carson_memory','user_text'],'settings','text','explicit_accept');
SELECT public.grant_ai_consent('aaaaaaaa-0000-4000-8000-000000000001','ai-v1','disclosure-v1','carson_reasoning','provider','anthropic',ARRAY['user_text','carson_memory'],'settings','text','explicit_accept');
DO $$ BEGIN
  IF (SELECT count(*) FROM public.ai_consent_events) <> 1 THEN RAISE EXCEPTION 'exact grant replay duplicated evidence'; END IF;
  IF EXISTS (SELECT 1 FROM public.ai_consent_events WHERE id='aaaaaaaa-0000-4000-8000-000000000001' AND user_id <> auth.uid()) THEN
    RAISE EXCEPTION 'grant ownership was not server derived';
  END IF;
  BEGIN
    PERFORM public.grant_ai_consent('aaaaaaaa-0000-4000-8000-000000000001','ai-v1','disclosure-v1','different_purpose','provider','anthropic',ARRAY['user_text','carson_memory'],'settings','text','explicit_accept');
    RAISE EXCEPTION 'conflicting event-id replay unexpectedly succeeded';
  EXCEPTION WHEN integrity_constraint_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.ai_consent_events (id,user_id,event_type,contract_version,disclosure_version,purpose,provider_scope_kind,provider_scope,data_categories,source_surface,input_mode,affirmative_action,actor_kind,actor_user_id)
    VALUES ('aaaaaaaa-0000-4000-8000-000000000099',auth.uid(),'grant','ai-v1','disclosure-v1','carson_reasoning','provider','anthropic',ARRAY['user_text'],'direct','text','explicit_accept','authenticated_user',auth.uid());
    RAISE EXCEPTION 'authenticated direct insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.ai_consent_events SET purpose='rewritten'; RAISE EXCEPTION 'authenticated update unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.ai_consent_events; RAISE EXCEPTION 'authenticated delete unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

-- Owner B sees only B and cannot withdraw A.
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
SELECT public.grant_ai_consent('bbbbbbbb-0000-4000-8000-000000000001','ai-v1','disclosure-v1','carson_reasoning','provider','anthropic',ARRAY['user_text'],'settings','text','explicit_accept');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.ai_consent_events WHERE user_id='11111111-1111-4111-8111-111111111111') THEN RAISE EXCEPTION 'cross-tenant read leaked A'; END IF;
  IF (SELECT count(*) FROM public.ai_consent_events) <> 1 THEN RAISE EXCEPTION 'owner B did not see exactly B evidence'; END IF;
  BEGIN
    PERFORM public.withdraw_ai_consent('bbbbbbbb-0000-4000-8000-000000000099','aaaaaaaa-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'cross-tenant withdrawal unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF has_function_privilege('authenticated','public.evaluate_ai_consent_authority(uuid,text,text,text,text,text[])','EXECUTE') THEN RAISE EXCEPTION 'authenticated can evaluate'; END IF;
  IF has_function_privilege('authenticated','public.supersede_ai_consent(uuid,uuid,uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'authenticated can supersede'; END IF;
END $$;
RESET ROLE;

-- Service-only deterministic allow/deny matrix.
SET ROLE service_role;
DO $$ DECLARE v record; BEGIN
  IF NOT has_function_privilege('service_role','public.evaluate_ai_consent_authority(uuid,text,text,text,text,text[])','EXECUTE') THEN RAISE EXCEPTION 'service evaluator privilege missing'; END IF;
  SELECT * INTO v FROM public.evaluate_ai_consent_authority('11111111-1111-4111-8111-111111111111','ai-v1','anthropic','ai_model_provider','carson_reasoning',ARRAY['user_text','carson_memory']);
  IF NOT v.authorized THEN RAISE EXCEPTION 'valid exact authority denied: %',v.reason; END IF;
  SELECT * INTO v FROM public.evaluate_ai_consent_authority('33333333-3333-4333-8333-333333333333','ai-v1','anthropic','ai_model_provider','carson_reasoning',ARRAY['user_text']);
  IF v.authorized THEN RAISE EXCEPTION 'missing grant authorized'; END IF;
  SELECT * INTO v FROM public.evaluate_ai_consent_authority('11111111-1111-4111-8111-111111111111','ai-v1','openai','other_category','carson_reasoning',ARRAY['user_text']);
  IF v.authorized THEN RAISE EXCEPTION 'wrong provider authorized'; END IF;
  SELECT * INTO v FROM public.evaluate_ai_consent_authority('11111111-1111-4111-8111-111111111111','ai-v1','anthropic','ai_model_provider','audio_transcription',ARRAY['user_text']);
  IF v.authorized THEN RAISE EXCEPTION 'wrong purpose authorized'; END IF;
  SELECT * INTO v FROM public.evaluate_ai_consent_authority('11111111-1111-4111-8111-111111111111','ai-v1','anthropic','ai_model_provider','carson_reasoning',ARRAY['audio']);
  IF v.authorized THEN RAISE EXCEPTION 'missing category authorized'; END IF;
  SELECT * INTO v FROM public.evaluate_ai_consent_authority('11111111-1111-4111-8111-111111111111','ai-v1','anthropic','ai_model_provider','carson_reasoning',ARRAY['user_text','carson_memory','audio']);
  IF v.authorized THEN RAISE EXCEPTION 'broader category request authorized'; END IF;
  SELECT * INTO v FROM public.evaluate_ai_consent_authority('11111111-1111-4111-8111-111111111111','ai-v2','anthropic','ai_model_provider','carson_reasoning',ARRAY['user_text']);
  IF v.authorized THEN RAISE EXCEPTION 'stale-version grant authorized'; END IF;
END $$;
RESET ROLE;

-- Withdrawal wins and exact replay stays singular.
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SELECT public.withdraw_ai_consent('aaaaaaaa-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-000000000001');
SELECT public.withdraw_ai_consent('aaaaaaaa-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-000000000001');
RESET ROLE;

SET ROLE service_role;
DO $$ DECLARE v record; BEGIN
  IF (SELECT count(*) FROM public.ai_consent_events WHERE target_grant_id='aaaaaaaa-0000-4000-8000-000000000001' AND event_type='withdraw') <> 1 THEN RAISE EXCEPTION 'withdrawal replay duplicated evidence'; END IF;
  SELECT * INTO v FROM public.evaluate_ai_consent_authority('11111111-1111-4111-8111-111111111111','ai-v1','anthropic','ai_model_provider','carson_reasoning',ARRAY['user_text']);
  IF v.authorized THEN RAISE EXCEPTION 'withdrawn grant authorized'; END IF;
END $$;
RESET ROLE;

-- The service role has no UPDATE/DELETE grant. Prove the immutable trigger
-- separately as the database owner, which otherwise has table privileges.
DO $$ BEGIN
  BEGIN UPDATE public.ai_consent_events SET purpose='rewritten' WHERE id='aaaaaaaa-0000-4000-8000-000000000001'; RAISE EXCEPTION 'historical update succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
  BEGIN DELETE FROM public.ai_consent_events WHERE id='aaaaaaaa-0000-4000-8000-000000000001'; RAISE EXCEPTION 'historical delete succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
END $$;

-- A new explicit v2 grant can authorize, then service supersession revokes it.
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SELECT public.grant_ai_consent('aaaaaaaa-0000-4000-8000-000000000003','ai-v2','disclosure-v2','carson_reasoning','provider','anthropic',ARRAY['user_text'],'settings','text','explicit_accept');
RESET ROLE;
SET ROLE service_role;
DO $$ DECLARE v record; BEGIN
  SELECT * INTO v FROM public.evaluate_ai_consent_authority('11111111-1111-4111-8111-111111111111','ai-v2','anthropic','ai_model_provider','carson_reasoning',ARRAY['user_text']);
  IF NOT v.authorized THEN RAISE EXCEPTION 'fresh explicit v2 grant denied'; END IF;
END $$;
SELECT public.supersede_ai_consent('aaaaaaaa-0000-4000-8000-000000000004','11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000003','material_change');
DO $$ DECLARE v record; BEGIN
  SELECT * INTO v FROM public.evaluate_ai_consent_authority('11111111-1111-4111-8111-111111111111','ai-v2','anthropic','ai_model_provider','carson_reasoning',ARRAY['user_text']);
  IF v.authorized THEN RAISE EXCEPTION 'superseded grant authorized'; END IF;
END $$;
RESET ROLE;

SELECT 'ai consent authority real-Postgres verification passed' AS status;
