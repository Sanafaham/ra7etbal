/**
 * Minimal Supabase-compatible bootstrap for verifying
 * 20260726_staff_escalation_owner_decisions.sql (and its two prerequisite
 * migrations, 20260720_create_staff_messages.sql and
 * 20260724_staff_message_response_delivery.sql) against a genuine,
 * ephemeral, plain PostgreSQL instance in CI.
 *
 * This is NOT a full Supabase emulation. It provides exactly the
 * prerequisite objects those three migrations reference and nothing more:
 *
 *  - the `auth` schema and a minimal `auth.users` table (FK target only —
 *    real Supabase's auth.users has dozens of columns; only `id` is ever
 *    referenced by these migrations)
 *  - `auth.uid()`, reproduced to read the exact same GUCs Supabase's real
 *    implementation reads (`request.jwt.claim.sub`, falling back to the
 *    `sub` field of `request.jwt.claims`), so `SET ROLE authenticated` +
 *    `SET request.jwt.claim.sub = '<uuid>'` reproduces real RLS behavior
 *    identically to production
 *  - the `anon` / `authenticated` / `service_role` roles (Supabase-managed
 *    in production; created here as plain Postgres roles so the
 *    migrations' own REVOKE/GRANT statements execute unmodified)
 *  - `pgcrypto`, defensively, for `gen_random_uuid()` (built into Postgres
 *    core since v13, but this makes the bootstrap version-independent)
 *  - minimal `public.people` / `public.tasks` tables carrying only the
 *    columns the staff_messages / staff_escalation_owner_decisions
 *    migrations actually read or reference via foreign key
 *
 * None of the migrations under test are modified to accommodate this
 * bootstrap — they run completely unmodified, exactly as committed.
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
    -- BYPASSRLS matches real Supabase: service_role bypasses RLS by
    -- design, same as the migrations' own comments state.
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

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

-- ── Minimal public.people / public.tasks ────────────────────────────────
-- Only the columns claim_staff_message() (people.user_id/name/phone/
-- is_family) and the escalation migration's task_id FK (tasks.id) require.

CREATE TABLE IF NOT EXISTS public.people (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name      text NOT NULL,
  phone     text,
  is_family boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.tasks (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
);

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON public.people, public.tasks TO authenticated, service_role;

SELECT 'bootstrap complete' AS status;
