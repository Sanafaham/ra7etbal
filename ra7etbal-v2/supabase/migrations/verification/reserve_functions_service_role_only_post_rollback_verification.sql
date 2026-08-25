DO $$
BEGIN
  IF NOT has_function_privilege('anon', 'public.reserve_custom_instruction(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.reserve_custom_instruction(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.reserve_rejected_alternative(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.reserve_rejected_alternative(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: rollback did not restore the prior client-role grants';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.reserve_custom_instruction(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.reserve_rejected_alternative(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: rollback changed required service_role execution';
  END IF;
  RAISE NOTICE 'PASS: rollback restores prior client-role grants and preserves service_role';
END $$;
