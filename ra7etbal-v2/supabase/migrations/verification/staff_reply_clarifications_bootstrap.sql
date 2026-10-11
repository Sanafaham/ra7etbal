/**
 * Extends 00_bootstrap_minimal_auth.sql with the public.tasks columns that
 * open_/resolve_staff_reply_clarification read (status, assigned_to).
 * Test-database only; never applied to Production.
 */
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS status      text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS assigned_to text,
  ADD COLUMN IF NOT EXISTS description text;

SELECT 'staff reply clarification bootstrap complete' AS status;
