-- Emergency rollback only: restore the exact client-role grants that existed
-- before 20260825170000_reserve_functions_service_role_only.sql.

GRANT EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text, uuid)
  TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_rejected_alternative(uuid, uuid, uuid, text, text, text, text, uuid)
  TO anon, authenticated;
