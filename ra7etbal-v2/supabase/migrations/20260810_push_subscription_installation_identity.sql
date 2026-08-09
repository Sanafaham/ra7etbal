/**
 * Push Subscription Installation Identity + Atomic Replacement.
 *
 * Fixes two confirmed production limitations left open by PR #207/#209
 * (see RA7ETBAL_STATE.md's "PWA push-subscription accumulation and
 * restoration" entry):
 *
 *  1. Same-platform multi-device collision — the client-side dedupe
 *     shipped in PR #207 scoped superseding by (user_id, platform), which
 *     cannot distinguish two genuinely different devices sharing the same
 *     platform string (e.g. two real iPhones). Fixed here by scoping to a
 *     client-generated, per-installation `installation_id` instead, which
 *     structurally cannot collide across real devices.
 *  2. Non-atomic concurrent save/dedupe race — the two-request client
 *     flow (select, then insert/update, then a separate dedupe UPDATE)
 *     let two concurrent saves for the same installation each supersede
 *     the other's just-written row. Fixed here by moving save+supersede
 *     into one PL/pgSQL function (a single transaction) serialized by a
 *     transaction-scoped advisory lock keyed on (user_id, installation_id).
 *
 * Deliberately NOT included (see the Engineering Completeness Review
 * design discussion — no safe deterministic signal exists for this):
 *  - Any age/inactivity-based cleanup of rows orphaned by iOS evicting a
 *    PWA's storage or a home-screen reinstall. Absence of recent activity
 *    is not proof a device is dead — a legitimate second device can be
 *    idle for a long time and must never be disabled for that reason
 *    alone. Orphaned rows remain enabled until one of three existing,
 *    genuinely evidence-based mechanisms resolves them: provider 404/410
 *    (api/send-push-for-task.js / api/send-due-reminder-pushes.js,
 *    untouched by this migration), explicit user disable (Settings,
 *    untouched), or the exact same installation_id resubscribing (this
 *    migration's own mechanism). See "Push Subscription Installation
 *    Management / Orphan Resolution" in RA7ETBAL_STATE.md for the
 *    intentionally-deferred, non-guessing follow-up (a user-facing
 *    management UI, not a background sweep).
 *
 * Additive and backward-compatible: `installation_id` is nullable and
 * never backfilled by guessing. Existing rows keep working exactly as
 * before; each one lazily adopts its real device's installation_id the
 * next time that device performs any save (Settings Enable/Refresh, or a
 * pushsubscriptionchange rotation) — see src/lib/push-notifications.ts.
 */

-- ── Column + indexes ─────────────────────────────────────────────────────

ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS installation_id uuid NULL;

-- Fast lookup by installation. Partial (installation_id IS NOT NULL) so
-- legacy rows never bloat this index.
CREATE INDEX IF NOT EXISTS push_subscriptions_user_installation_idx
  ON public.push_subscriptions (user_id, installation_id)
  WHERE installation_id IS NOT NULL;

-- Database-level invariant: at most one ENABLED row per real installation.
-- Defense in depth, not the primary serialization mechanism (the advisory
-- lock inside upsert_push_subscription is) — this exists so the invariant
-- holds even against a future write path that forgets to take the lock,
-- failing loudly (unique_violation) rather than silently corrupting state.
-- No-op against current production data: zero existing rows have
-- installation_id set yet, so this predicate matches nothing today.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_one_enabled_per_installation
  ON public.push_subscriptions (user_id, installation_id)
  WHERE enabled = true AND installation_id IS NOT NULL;

-- ── Atomic upsert + supersede RPC ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_expiration_time timestamptz,
  p_user_agent text,
  p_platform text,
  p_installation_id uuid
) RETURNS TABLE (id uuid, superseded_count int)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_superseded int := 0;
BEGIN
  IF p_installation_id IS NOT NULL THEN
    -- Transaction-scoped: auto-released on commit OR rollback, no manual
    -- unlock, no leak risk. Serializes every concurrent call for this
    -- exact (user, installation) pair — see the migration verification
    -- suite's dblink-based genuine two-connection concurrency tests for
    -- proof this actually blocks, not just "is atomic per call".
    PERFORM pg_advisory_xact_lock(
      hashtextextended(auth.uid()::text || ':' || p_installation_id::text, 0)
    );

    -- Disable-first, upsert-enable-last. Disabling BEFORE inserting the
    -- new row avoids ever having two enabled rows for this installation
    -- exist at the same time within this very transaction (which would
    -- trip push_subscriptions_one_enabled_per_installation immediately,
    -- before the supersede step ever ran, in the reversed order).
    -- Excludes the target endpoint itself so a pure re-save of the same
    -- endpoint never toggles it off-then-on — the upsert below just
    -- refreshes it in place.
    UPDATE public.push_subscriptions
       SET enabled = false, updated_at = now()
     WHERE user_id = auth.uid()
       AND installation_id = p_installation_id
       AND enabled = true
       AND endpoint <> p_endpoint;
    GET DIAGNOSTICS v_superseded = ROW_COUNT;
  END IF;

  INSERT INTO public.push_subscriptions
    (user_id, endpoint, p256dh, auth, expiration_time, user_agent, platform, installation_id, enabled)
  VALUES
    (auth.uid(), p_endpoint, p_p256dh, p_auth, p_expiration_time, p_user_agent, p_platform, p_installation_id, true)
  ON CONFLICT (user_id, endpoint) DO UPDATE SET
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    expiration_time = excluded.expiration_time,
    user_agent = excluded.user_agent,
    platform = excluded.platform,
    installation_id = excluded.installation_id,
    enabled = true,
    updated_at = now()
  RETURNING push_subscriptions.id INTO v_id;

  -- If this INSERT/UPDATE fails for any reason, the whole function's
  -- transaction rolls back — including the disable UPDATE above. The
  -- user's previously-working subscription is restored to exactly its
  -- pre-call state, never left disabled with nothing having replaced it.
  RETURN QUERY SELECT v_id, v_superseded;
END;
$$;

-- Postgres grants EXECUTE to PUBLIC on new functions by default, AND the
-- live Supabase project additionally has default privileges that grant
-- EXECUTE directly to anon/authenticated/service_role on every new
-- function in the public schema (confirmed live on project
-- ggarvhgqzpooloacjgcj — REVOKE ... FROM PUBLIC alone left anon able to
-- call this function, since that grant is direct to the anon role, not
-- inherited through PUBLIC). Revoke from both explicitly rather than
-- relying only on RLS as the backstop.
REVOKE EXECUTE ON FUNCTION public.upsert_push_subscription(
  text, text, text, timestamptz, text, text, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_push_subscription(
  text, text, text, timestamptz, text, text, uuid
) TO authenticated;
