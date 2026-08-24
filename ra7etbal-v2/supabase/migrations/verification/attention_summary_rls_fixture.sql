\set ON_ERROR_STOP on

-- Two owners. Owner A is the identity under test throughout verification;
-- Owner B exists solely so we can prove Owner A's SELECT never returns
-- Owner B's rows (and, symmetrically, that Owner B can still see their own).
INSERT INTO auth.users (id) VALUES
  ('11111111-1111-4111-8111-111111111111'), -- owner_a
  ('22222222-2222-4222-8222-222222222222');  -- owner_b

INSERT INTO public.people (id, user_id, name) VALUES
  ('a0000000-0000-4000-8000-00000000a001', '11111111-1111-4111-8111-111111111111', 'Owner A Staff'),
  ('a0000000-0000-4000-8000-00000000a002', '22222222-2222-4222-8222-222222222222', 'Owner B Staff');

-- Loaded as the connecting superuser (same convention as
-- carson_tier1_db_contracts_verification.sql's own fixtures) — these rows
-- represent server-owned writes (tasks/automations created by the app on
-- the owner's behalf, staff_messages exclusively by claim_staff_message(),
-- automation_runs exclusively by the runner), none of which this file is
-- testing the write-path privilege boundary for. What's under test below
-- is SELECT isolation for the authenticated role only.

INSERT INTO public.tasks (id, user_id, description, type) VALUES
  ('b0000000-0000-4000-8000-00000000b001', '11111111-1111-4111-8111-111111111111', 'Owner A private task', 'action'),
  ('b0000000-0000-4000-8000-00000000b002', '22222222-2222-4222-8222-222222222222', 'Owner B private task', 'action');

INSERT INTO public.staff_messages (
  id, user_id, person_id, staff_name, task_id, source, inbound_text, received_at
) VALUES
  ('c0000000-0000-4000-8000-00000000c001', '11111111-1111-4111-8111-111111111111',
   'a0000000-0000-4000-8000-00000000a001', 'Owner A Staff', 'b0000000-0000-4000-8000-00000000b001',
   'simulated', 'Owner A private staff message', now()),
  ('c0000000-0000-4000-8000-00000000c002', '22222222-2222-4222-8222-222222222222',
   'a0000000-0000-4000-8000-00000000a002', 'Owner B Staff', 'b0000000-0000-4000-8000-00000000b002',
   'simulated', 'Owner B private staff message', now());

INSERT INTO public.automations (id, user_id, title, instruction, cadence_type, next_run_at) VALUES
  ('d0000000-0000-4000-8000-00000000d001', '11111111-1111-4111-8111-111111111111',
   'Owner A automation', 'owner a instruction', 'once', now()),
  ('d0000000-0000-4000-8000-00000000d002', '22222222-2222-4222-8222-222222222222',
   'Owner B automation', 'owner b instruction', 'once', now());

INSERT INTO public.automation_runs (id, automation_id, user_id, task_id, run_for, current_state, sent_at) VALUES
  ('e0000000-0000-4000-8000-00000000e001', 'd0000000-0000-4000-8000-00000000d001',
   '11111111-1111-4111-8111-111111111111', 'b0000000-0000-4000-8000-00000000b001', now(), 'sent', now()),
  ('e0000000-0000-4000-8000-00000000e002', 'd0000000-0000-4000-8000-00000000d002',
   '22222222-2222-4222-8222-222222222222', 'b0000000-0000-4000-8000-00000000b002', now(), 'sent', now());

SELECT 'attention_summary_rls fixture loaded' AS status;
