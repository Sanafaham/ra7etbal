/**
 * Minimal Supabase-compatible bootstrap for proving the cross-owner SELECT
 * isolation boundary that get_items_needing_attention (attention_summary_read)
 * actually depends on: public.tasks, public.staff_messages,
 * public.automations, public.automation_runs.
 *
 * Reuses the exact same auth-schema/role/auth.uid() shape already
 * established by verification/00_bootstrap_minimal_auth.sql and
 * verification/server_authoritative_reminder_rls_bootstrap.sql — not a new
 * pattern. The public.tasks definition (columns, RLS policies) is copied
 * verbatim from server_authoritative_reminder_rls_bootstrap.sql, the one
 * existing bootstrap that already gives tasks its real, production-matching
 * RLS (00_bootstrap_minimal_auth.sql's tasks stub deliberately has none — it
 * only needs tasks.id as an FK target for a different verification chain).
 *
 * public.staff_messages, public.automations, and public.automation_runs are
 * NOT hand-defined here — this workflow applies the real, unmodified
 * production migrations (20260720_create_staff_messages.sql,
 * 20260620_agent_automation_layer.sql) immediately after this bootstrap, so
 * their schema and RLS policies are exactly what production runs, not a
 * reconstruction.
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

-- ── auth schema ──────────────────────────────────────────────────────────

CREATE SCHEMA auth;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO anon, authenticated, service_role;

-- ── public.people (minimal — only what automations.assignee_id and
--    staff_messages.person_id reference via FK) ────────────────────────────

CREATE TABLE public.people (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name      text NOT NULL,
  phone     text,
  is_family boolean NOT NULL DEFAULT false
);

GRANT SELECT ON public.people TO authenticated, service_role;

-- ── public.tasks (real production shape + RLS, copied from
--    server_authoritative_reminder_rls_bootstrap.sql) ───────────────────────

CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  description text NOT NULL,
  type text NOT NULL CHECK (type IN (
    'action', 'reminder', 'delegation', 'decision', 'followup', 'errand', 'parked'
  )),
  assigned_to text,
  status text NOT NULL DEFAULT 'pending',
  needs_follow_up boolean NOT NULL DEFAULT false,
  confirmation_url text,
  confirmed_at timestamptz,
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated, service_role;

CREATE POLICY "tasks: owner can select"
  ON public.tasks FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "tasks: owner can insert"
  ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "tasks: owner can update"
  ON public.tasks FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "tasks: owner can delete"
  ON public.tasks FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

SELECT 'attention_summary_rls bootstrap complete' AS status;
