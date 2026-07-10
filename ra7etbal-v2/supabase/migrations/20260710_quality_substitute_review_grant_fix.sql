/**
 * Corrective grant fix for 20260710_quality_substitute_review.sql
 *
 * Post-migration verification found that REVOKE EXECUTE ... FROM PUBLIC had
 * no effect on the 7 new SECURITY DEFINER functions: this project has a
 * schema-level default ACL (set via ALTER DEFAULT PRIVILEGES by the
 * `postgres` role) that grants EXECUTE on every new public-schema function
 * directly to anon/authenticated/service_role — not through PUBLIC
 * membership — so revoking from PUBLIC was a no-op.
 *
 * These functions trust a client-suppliable p_user_id parameter for the
 * ownership check, relying on the assumption that only the trusted
 * server-side endpoint (which derives that value from a verified Supabase
 * JWT) can ever call them. Leaving EXECUTE open to anon/authenticated would
 * let a caller pass an arbitrary p_user_id and bypass ownership entirely.
 *
 * No table schema, RLS policy, or function body changes here — grants only.
 */

REVOKE EXECUTE ON FUNCTION public.claim_substitute_decision(uuid, uuid, text, timestamptz, text, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reserve_rejected_alternative(uuid, uuid, uuid, text, text, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reserve_send_window(uuid, uuid, uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_approved_alternative(uuid, uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_rejected_alternative(uuid, uuid, uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_custom_instruction(uuid, uuid, uuid, uuid) FROM anon, authenticated;
