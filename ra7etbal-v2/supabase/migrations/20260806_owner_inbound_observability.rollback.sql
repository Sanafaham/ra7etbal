DROP FUNCTION IF EXISTS public.record_whatsapp_inbound_evidence(text, boolean, jsonb, jsonb, text, text, text, text, timestamptz);
DROP TRIGGER IF EXISTS reject_whatsapp_inbound_evidence_update ON public.whatsapp_inbound_evidence;
DROP FUNCTION IF EXISTS public.reject_whatsapp_inbound_evidence_mutation();
DROP TABLE IF EXISTS public.whatsapp_inbound_evidence;
