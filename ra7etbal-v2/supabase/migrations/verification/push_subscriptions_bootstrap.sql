/**
 * Minimal Supabase-compatible bootstrap for verifying
 * 20260810_push_subscription_installation_identity.sql against a genuine,
 * ephemeral, plain PostgreSQL instance in CI.
 *
 * Self-contained and independent of the staff-escalation verification
 * bootstrap (00_bootstrap_minimal_auth.sql) — this migration's forward/
 * rollback workflow is path-filtered separately and must not depend on
 * unrelated migration groups.
 *
 * push_subscriptions itself predates this repo's migrations convention
 * (there is no creation migration for it anywhere in this repo), so this
 * bootstrap recreates it here matching the real, live production schema
 * exactly (verified directly against Supabase project ggarvhgqzpooloacjgcj
 * on 2026-08-10): columns, PRIMARY KEY, UNIQUE (user_id, endpoint),
 * FOREIGN KEY to auth.users, RLS policies, and the pre-existing
 * push_subscriptions_set_updated_at trigger. The migration under test runs
 * completely unmodified against this.
 *
 * Also replicates a real Supabase behavior this bootstrap originally
 * missed and which let a genuine production security gap through this
 * exact CI suite undetected: the live project has default privileges
 * granting EXECUTE directly to anon/authenticated/service_role on every
 * new function created in the public schema — a grant independent of,
 * and not removed by, "REVOKE ... FROM PUBLIC" alone. Confirmed live: the
 * migration's first production apply correctly revoked PUBLIC's grant but
 * left anon able to call upsert_push_subscription via this direct grant,
 * caught only by a manual post-apply "SET ROLE anon" probe, not by this
 * (at-the-time incomplete) verification suite. See push_subscriptions_
 * security_verification.sql's grant tests, which now fail against a
 * migration that reverts to the PUBLIC-only revoke.
 */

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Roles ────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

-- Replicates the live Supabase project's actual default privileges: every
-- new function created by this role (postgres, matching CI's PGUSER) in
-- the public schema is automatically EXECUTE-granted directly to
-- anon/authenticated/service_role — independent of PUBLIC's own default
-- grant. Applies to every function created AFTER this statement,
-- including the migration-under-test's own upsert_push_subscription, so
-- this bootstrap genuinely reproduces the gap a REVOKE-FROM-PUBLIC-only
-- migration would leave open.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- ── auth schema ──────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO anon, authenticated, service_role;

-- ── public.push_subscriptions (pre-existing production table, recreated
--    verbatim for this bootstrap only) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint         text NOT NULL,
  p256dh           text NOT NULL,
  auth             text NOT NULL,
  expiration_time  timestamptz NULL,
  user_agent       text NULL,
  platform         text NULL,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_user_endpoint_unique UNIQUE (user_id, endpoint)
);

CREATE OR REPLACE FUNCTION public.set_push_subscriptions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;

CREATE TRIGGER push_subscriptions_set_updated_at
  BEFORE UPDATE ON public.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_push_subscriptions_updated_at();

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own subscriptions" ON public.push_subscriptions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;

SELECT 'push_subscriptions bootstrap complete' AS status;
