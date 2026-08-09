/**
 * Rollback for 20260810_push_subscription_installation_identity.sql.
 *
 * Pure reversal, no data loss beyond the tracked installation_id values
 * themselves — endpoint/keys/platform/enabled data on every row (legacy
 * and newly-identified) is untouched.
 */

REVOKE EXECUTE ON FUNCTION public.upsert_push_subscription(
  text, text, text, timestamptz, text, text, uuid
) FROM authenticated;

DROP FUNCTION IF EXISTS public.upsert_push_subscription(
  text, text, text, timestamptz, text, text, uuid
);

DROP INDEX IF EXISTS public.push_subscriptions_one_enabled_per_installation;
DROP INDEX IF EXISTS public.push_subscriptions_user_installation_idx;

ALTER TABLE public.push_subscriptions
  DROP COLUMN IF EXISTS installation_id;
