DO $$
BEGIN
  IF has_function_privilege('anon', 'public.reserve_custom_instruction(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon can execute reserve_custom_instruction';
  END IF;
  IF has_function_privilege('authenticated', 'public.reserve_custom_instruction(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated can execute reserve_custom_instruction';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.reserve_custom_instruction(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: service_role lost reserve_custom_instruction execution';
  END IF;
  IF has_function_privilege('anon', 'public.reserve_rejected_alternative(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon can execute reserve_rejected_alternative';
  END IF;
  IF has_function_privilege('authenticated', 'public.reserve_rejected_alternative(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated can execute reserve_rejected_alternative';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.reserve_rejected_alternative(uuid,uuid,uuid,text,text,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: service_role lost reserve_rejected_alternative execution';
  END IF;
  RAISE NOTICE 'PASS: reserve functions are executable only by service_role among API roles';
END $$;
