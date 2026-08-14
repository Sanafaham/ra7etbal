DROP FUNCTION IF EXISTS public.carson_production_canary_health(text);

DROP POLICY IF EXISTS "whatsapp_health_state: canary aggregate select" ON public.whatsapp_health_state;
DROP POLICY IF EXISTS "whatsapp_deliveries: canary aggregate select" ON public.whatsapp_deliveries;
DROP POLICY IF EXISTS "automation_runs: canary aggregate select" ON public.automation_runs;
DROP POLICY IF EXISTS "automations: canary aggregate select" ON public.automations;

REVOKE ALL ON TABLE carson_canary_private.config FROM carson_canary_function_owner;
REVOKE ALL ON public.whatsapp_health_state FROM carson_canary_function_owner;
REVOKE ALL ON public.whatsapp_deliveries FROM carson_canary_function_owner;
REVOKE ALL ON public.automation_runs FROM carson_canary_function_owner;
REVOKE ALL ON public.automations FROM carson_canary_function_owner;
REVOKE ALL ON SCHEMA carson_canary_private, public FROM carson_canary_function_owner;

DROP TABLE IF EXISTS carson_canary_private.config;
DROP ROLE IF EXISTS carson_canary_function_owner;
DROP SCHEMA IF EXISTS carson_canary_private;
