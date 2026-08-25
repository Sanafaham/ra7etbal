-- Restore the documented service-role-only boundary for the current
-- eight-argument worker-notification reservation RPCs. Supabase's explicit
-- anon/authenticated default function grants survived the prior PUBLIC-only
-- revoke when these signatures were created.

REVOKE EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text, uuid)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.reserve_rejected_alternative(uuid, uuid, uuid, text, text, text, text, uuid)
  FROM anon, authenticated;
