/**
 * Rollback for 20260710_quality_substitute_review_grant_fix.sql
 *
 * Restores EXECUTE to anon/authenticated (matching this project's default
 * ACL, i.e. undoes the corrective revoke). Only meaningful if the entire
 * Phase 8.1 feature is being rolled back alongside the base migration —
 * there is no standalone reason to run this without also rolling back
 * 20260710_quality_substitute_review.sql.
 */

GRANT EXECUTE ON FUNCTION public.claim_substitute_decision(uuid, uuid, text, timestamptz, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_rejected_alternative(uuid, uuid, uuid, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_send_window(uuid, uuid, uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_approved_alternative(uuid, uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_rejected_alternative(uuid, uuid, uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_custom_instruction(uuid, uuid, uuid, uuid) TO anon, authenticated;
