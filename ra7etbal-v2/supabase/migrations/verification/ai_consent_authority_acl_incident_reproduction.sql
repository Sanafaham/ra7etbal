\set ON_ERROR_STOP on

-- Negative control: faithfully reproduce the Production incident before the
-- ACL-safe replacement migration is allowed to claim the defect is closed.
DO $$ BEGIN
  IF NOT has_table_privilege('service_role', 'public.ai_consent_events', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.ai_consent_events', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.ai_consent_events', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.ai_consent_events', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.ai_consent_events', 'TRUNCATE')
     OR NOT has_table_privilege('service_role', 'public.ai_consent_events', 'REFERENCES')
     OR NOT has_table_privilege('service_role', 'public.ai_consent_events', 'TRIGGER') THEN
    RAISE EXCEPTION 'Supabase-parity default ACL did not reproduce broad service_role privileges';
  END IF;
END $$;

SET ROLE service_role;
INSERT INTO public.ai_consent_events (
  id, user_id, event_type, contract_version, disclosure_version, purpose,
  provider_scope_kind, provider_scope, data_categories, source_surface,
  input_mode, affirmative_action, actor_kind, actor_user_id
) VALUES (
  'dddddddd-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'grant', 'incident-v1', 'incident-v1', 'incident_reproduction',
  'provider', 'anthropic', ARRAY['user_text'], 'ci_negative_control',
  'text', 'explicit_accept', 'authenticated_user',
  '11111111-1111-4111-8111-111111111111'
);
TRUNCATE public.ai_consent_events;
RESET ROLE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.ai_consent_events) THEN
    RAISE EXCEPTION 'incident reproduction TRUNCATE did not erase the probe row';
  END IF;
END $$;

SELECT 'ai consent Supabase-parity ACL incident reproduced' AS status;
