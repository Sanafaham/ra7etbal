DROP FUNCTION IF EXISTS public.evaluate_ai_consent_authority(uuid, text, text, text, text, text[]);
DROP FUNCTION IF EXISTS public.supersede_ai_consent(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.withdraw_ai_consent(uuid, uuid);
DROP FUNCTION IF EXISTS public.grant_ai_consent(uuid, text, text, text, text, text, text[], text, text, text);
DROP TRIGGER IF EXISTS reject_ai_consent_event_mutation ON public.ai_consent_events;
DROP FUNCTION IF EXISTS public.reject_ai_consent_event_mutation();
DROP TABLE IF EXISTS public.ai_consent_events;
