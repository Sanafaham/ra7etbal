CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA auth;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

GRANT USAGE ON SCHEMA auth, public TO authenticated, service_role;

-- The columns and constraints relevant to task creation mirror the production
-- task contract. In particular, type is required and has no default: every
-- legitimate writer must name its task type explicitly.
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

-- Existing production owner policies. The migration under test must compose
-- with these policies without replacing or weakening them.
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
