/**
 * Extends verification/00_bootstrap_minimal_auth.sql with the minimal
 * additional objects Phase 4's Tier 1 database-contract suite needs, which
 * 00_bootstrap_minimal_auth.sql (written for the staff-escalation
 * migration chain only) does not provide.
 *
 * public.messages is the one genuinely new bootstrap table here — its real
 * CREATE TABLE/RLS DDL predates this repository's tracked migration
 * history (confirmed: no migration file under supabase/migrations creates
 * it — a full-directory grep for its CREATE TABLE statement returns no
 * matches). This is a documented, honest gap — see the Phase 4 report's
 * "L. anything PostgreSQL protection cannot catch" section. The columns
 * below are not invented: every one is read directly from a real,
 * currently-applied migration that INSERTs into or ALTERs
 * public.messages (20260812_worker_notification_person_id.sql's
 * reserve_custom_instruction/reserve_rejected_alternative INSERT list;
 * 20260812_durable_person_id_communication_history.sql's comment
 * "messages.person_id already exists as a plain uuid column (no FK)").
 * Because the real RLS policy text for this table cannot be verified from
 * any tracked migration, this bootstrap deliberately does NOT enable RLS
 * or create a policy on it — a contract test built on an invented policy
 * would prove nothing about production. Contract tests in this suite only
 * assert what is independently provable: that person_id survives writes
 * made by the real, tracked RPCs.
 */

CREATE TABLE IF NOT EXISTS public.messages (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id           uuid        NULL REFERENCES public.tasks(id) ON DELETE SET NULL,
  person_id         uuid        NULL, -- no FK in production either (see 20260812_durable_person_id_communication_history.sql's own comment)
  recipient         text        NULL,
  recipient_name    text        NULL,
  content           text        NULL,
  body              text        NULL,
  confirmation_url  text        NULL,
  channel           text        NULL,
  status            text        NULL,
  whatsapp_message_id text      NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Additional tasks columns the quality-substitute-review and task-based
-- owner-decision RPCs (applied later in this suite) require, beyond the
-- minimal id/user_id columns 00_bootstrap_minimal_auth.sql provides for
-- the (unrelated) staff-escalation chain.
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS assigned_to text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS quality_review_status text,
  ADD COLUMN IF NOT EXISTS quality_review_note text,
  ADD COLUMN IF NOT EXISTS quality_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS quality_review_cycle_count int,
  ADD COLUMN IF NOT EXISTS worker_reply text,
  ADD COLUMN IF NOT EXISTS needs_follow_up boolean NOT NULL DEFAULT false;

-- Real Supabase projects grant service_role blanket table privileges
-- (SELECT/INSERT/UPDATE/DELETE) on every table in the public schema at the
-- project/role-membership level, outside of any migration file — this is
-- why the migrations for whatsapp_health_state/whatsapp_deliveries/
-- staff_escalation_owner_decisions only ever GRANT SELECT to
-- `authenticated` and never mention service_role at all (BYPASSRLS alone
-- bypasses row-security policies, not GRANT-based table ACLs — the two are
-- independent Postgres mechanisms). 00_bootstrap_minimal_auth.sql predates
-- this need (the staff-escalation chain it was built for never required
-- service_role to write to whatsapp_health_state/whatsapp_deliveries).
-- Replicating Supabase's real, documented default here — not inventing a
-- new privilege — is required for the server-side (service-role) write
-- paths this suite verifies to run at all.
-- Applies to tables that already exist at this point in the chain; the
-- ALTER DEFAULT PRIVILEGES below (Supabase's own real mechanism) covers
-- every table created by a migration applied after this one.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;

SELECT 'carson tier1 bootstrap extension complete' AS status;
