/**
 * Carson Tier 1 real-PostgreSQL database contract verification.
 * Phase 4 of the Carson Engineering Hardening Project.
 *
 * Applied after (in order): 00_bootstrap_minimal_auth.sql,
 * 20260613_routines.sql, 20260620_agent_automation_layer.sql,
 * 20260622_whatsapp_health_state.sql, carson_tier1_bootstrap_extension.sql,
 * 20260622_whatsapp_deliveries.sql, 20260710_quality_substitute_review.sql,
 * 20260712_approve_alternative_message_first.sql,
 * 20260720_create_staff_messages.sql,
 * 20260726_staff_escalation_owner_decisions.sql,
 * 20260801_task_based_escalation_owner_decisions.sql,
 * 20260812_durable_person_id_communication_history.sql,
 * 20260812_task_review_owner_decision_person_id.sql,
 * 20260812_worker_notification_person_id.sql — the exact, real, unmodified
 * production migrations that construct the CURRENT schema for these four
 * Tier 1 tables (see .github/workflows/carson-tier1-db-contracts.yml for
 * the full applied order). 20260813_whatsapp_health_state_phone_number_unique.sql
 * is applied and rolled back separately by the workflow, not here.
 *
 * Each check RAISE NOTICEs "PASS: ..." on success; any failure RAISE
 * EXCEPTIONs "FAIL: ..." with ON_ERROR_STOP, which aborts the whole script
 * (and the CI job) with a nonzero exit code.
 */

\set ON_ERROR_STOP on

-- ── Fixture identities ──────────────────────────────────────────────────
INSERT INTO auth.users (id) VALUES
  ('11111111-1111-4111-8111-111111111111'), -- owner_a
  ('22222222-2222-4222-8222-222222222222')   -- owner_b
ON CONFLICT DO NOTHING;

INSERT INTO public.people (id, user_id, name, phone) VALUES
  ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Christopher', '+12025691377')
ON CONFLICT DO NOTHING;

INSERT INTO public.tasks (id, user_id, description, status) VALUES
  ('a2000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'owner_a task', 'pending')
ON CONFLICT DO NOTHING;

-- =========================================================================
-- 1. whatsapp_health_state — canonical-owner binding
-- =========================================================================

SET ROLE service_role;
INSERT INTO public.whatsapp_health_state (user_id, phone_number_id)
VALUES ('11111111-1111-4111-8111-111111111111', 'phone-canonical-1');
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_health_state WHERE phone_number_id = 'phone-canonical-1') THEN
    RAISE EXCEPTION 'FAIL: canonical valid binding did not persist';
  END IF;
  RAISE NOTICE 'PASS: 1a. canonical valid binding succeeds';
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.whatsapp_health_state (user_id, phone_number_id)
    VALUES ('22222222-2222-4222-8222-222222222222', 'phone-canonical-1'); -- same number, different user
    RAISE EXCEPTION 'FAIL: a second user was able to bind the same phone_number_id';
  EXCEPTION WHEN unique_violation THEN
    NULL; -- expected: UNIQUE(phone_number_id) rejects it
  END;
  RAISE NOTICE 'PASS: 1b. UNIQUE(phone_number_id) rejects a second user binding the same number — protects the canonical-owner contamination incident class';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_health_state_phone_number_id_unique'
      AND conrelid = 'public.whatsapp_health_state'::regclass
  ) THEN
    RAISE EXCEPTION 'FAIL: whatsapp_health_state_phone_number_id_unique constraint does not exist';
  END IF;
  RAISE NOTICE 'PASS: 1c. the migration-established UNIQUE(phone_number_id) constraint exists in the catalog';
END $$;

-- RLS: owner isolation
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  IF (SELECT count(*) FROM public.whatsapp_health_state WHERE phone_number_id = 'phone-canonical-1') <> 1 THEN
    RAISE EXCEPTION 'FAIL: owner_a should see their own whatsapp_health_state row';
  END IF;
END $$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.whatsapp_health_state WHERE phone_number_id = 'phone-canonical-1') THEN
    RAISE EXCEPTION 'FAIL: owner_b must NOT see owner_a''s whatsapp_health_state row';
  END IF;
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'PASS: 1d. RLS — owner_a sees their row, owner_b (end-user RLS contract) sees none'; END $$;

-- Service-role vs. end-user contract: authenticated cannot write at all.
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  BEGIN
    INSERT INTO public.whatsapp_health_state (user_id, phone_number_id)
    VALUES (auth.uid(), 'phone-authenticated-attempt');
    RAISE EXCEPTION 'FAIL: authenticated should not be able to INSERT whatsapp_health_state';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'PASS: 1e. service-role distinction — authenticated cannot write at all; only service_role (already exercised in 1a) can'; END $$;

-- =========================================================================
-- 2. whatsapp_deliveries — identity, linkage, durability, RLS
-- =========================================================================

SET ROLE service_role;
INSERT INTO public.whatsapp_deliveries (id, user_id, task_id, person_id, source_type, recipient_phone)
VALUES ('a3000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
        'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
        'delegation', '+12025691377');

-- Nullable person_id is intentional (ambiguous/zero-match assignee names) —
-- prove it's still accepted, never impose a NOT NULL the architecture
-- doesn't ask for.
INSERT INTO public.whatsapp_deliveries (id, user_id, task_id, person_id, source_type, recipient_phone)
VALUES ('a3000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
        'a2000000-0000-4000-8000-000000000001', NULL,
        'delegation', '+12025691377');

-- automation-run linkage: task_id null, automation_run_id set (the exact
-- automation-runner call shape from Phase 3's Journey 4).
INSERT INTO public.automations (id, user_id, title, instruction, cadence_type, next_run_at)
VALUES ('a4000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Test automation', 'test automation', 'once', now());
INSERT INTO public.automation_runs (id, automation_id, user_id, run_for, current_state)
VALUES ('a5000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001',
        '11111111-1111-4111-8111-111111111111', now(), 'task_created');
INSERT INTO public.whatsapp_deliveries (id, user_id, automation_run_id, person_id, source_type, recipient_phone)
VALUES ('a3000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
        'a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
        'automation_delegation', '+12025691377');
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.whatsapp_deliveries WHERE id IN (
    'a3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000003'
  )) <> 3 THEN
    RAISE EXCEPTION 'FAIL: expected all 3 whatsapp_deliveries fixtures (with and without person_id, with automation_run_id) to persist';
  END IF;
  RAISE NOTICE 'PASS: 2a. person_id/task_id/automation_run_id linkage fields accepted exactly as production writes them — nullable person_id intentionally still valid';
END $$;

-- Durability: deleting the linked task nulls task_id (ON DELETE SET NULL)
-- but leaves person_id untouched — the exact DB-enforced transformation
-- Phase 3's Communication History durability journey assumed, now proven
-- at the real database layer rather than simulated in a mock.
SET ROLE service_role;
DELETE FROM public.tasks WHERE id = 'a2000000-0000-4000-8000-000000000001';
RESET ROLE;

DO $$
DECLARE v_task_id uuid; v_person_id uuid;
BEGIN
  SELECT task_id, person_id INTO v_task_id, v_person_id
  FROM public.whatsapp_deliveries WHERE id = 'a3000000-0000-4000-8000-000000000001';
  IF v_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: task_id should be NULL after the linked task was deleted (ON DELETE SET NULL)';
  END IF;
  IF v_person_id IS DISTINCT FROM 'a1000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL: person_id must survive task deletion — it has no FK relationship to tasks at all';
  END IF;
  RAISE NOTICE 'PASS: 2b. real ON DELETE SET NULL on task_id, person_id genuinely untouched — the durable person_id architecture, proven at the DB layer';
END $$;

-- RLS: owner can SELECT own rows only; cannot write at all (real production
-- comment: "Server-side code writes with the service role. Authenticated
-- owners may read their own rows, but cannot insert, update, or delete
-- delivery evidence.")
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  IF (SELECT count(*) FROM public.whatsapp_deliveries WHERE user_id = auth.uid()) <> 3 THEN
    RAISE EXCEPTION 'FAIL: owner_a should see exactly their 3 whatsapp_deliveries rows';
  END IF;
END $$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.whatsapp_deliveries WHERE user_id = '11111111-1111-4111-8111-111111111111') THEN
    RAISE EXCEPTION 'FAIL: owner_b must NOT see owner_a''s whatsapp_deliveries rows';
  END IF;
  BEGIN
    UPDATE public.whatsapp_deliveries SET delivery_status = 'read'
    WHERE id = 'a3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'FAIL: owner_b should not be able to UPDATE any whatsapp_deliveries row (cross-account mutation)';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  BEGIN
    UPDATE public.whatsapp_deliveries SET delivery_status = 'read'
    WHERE id = 'a3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'FAIL: authenticated should not be able to UPDATE even their own whatsapp_deliveries row — writes are service_role only by design';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'PASS: 2c. RLS — owner reads only their own rows, cross-account read/write rejected, and same-account write is also rejected (service-role-only write is a deliberate architectural choice, not a bug)'; END $$;

-- =========================================================================
-- 3. messages — durable person identity (honest, bounded scope)
-- =========================================================================
-- NOTE: public.messages' own real RLS policy DDL is not present in any
-- tracked migration (see carson_tier1_bootstrap_extension.sql's header) —
-- this section does NOT assert RLS for messages, since there is no real
-- policy text to verify against. It proves only what real, tracked RPCs
-- (reserve_custom_instruction / reserve_rejected_alternative) demonstrably
-- do: thread person_id through on write, and leave it durable across task
-- deletion.
--
-- Implemented as one PL/pgSQL block with local variables, not chained
-- top-level statements with psql client-side variable capture — the
-- client-side "capture a function result into a psql variable, then
-- interpolate it into a later dollar-quoted DO block" pattern proved
-- unreliable while building this suite (colon-quote interpolation inside
-- $$ ... $$ blocks did not reliably substitute across all invocation
-- modes). Plain PL/pgSQL variables inside one block have no such issue and
-- are the same pattern the existing 02_lifecycle_verification.sql already
-- uses successfully.

SET ROLE service_role;
INSERT INTO public.tasks (id, user_id, description, status, assigned_to, quality_review_status, quality_reviewed_at)
VALUES ('a6000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
        'substitute review task', 'pending', 'Christopher', 'substitute_review', '2026-08-14T10:00:00Z');
RESET ROLE;

DO $$
DECLARE
  v_claim   quality_substitute_decisions;
  v_reserve record;
  v_person_id uuid;
  v_delivery_person_id uuid;
  v_task_id uuid;
BEGIN
  v_claim := public.claim_substitute_decision(
    'a6000000-0000-4000-8000-000000000001'::uuid,
    '11111111-1111-4111-8111-111111111111'::uuid,
    'custom_instruction'
  );
  RAISE NOTICE 'PASS: 3a. claim_substitute_decision claimed a decision row for the task-based owner-decision flow (decision_id=%)', v_claim.id;

  SELECT * INTO v_reserve FROM public.reserve_custom_instruction(
    v_claim.id, v_claim.lease_token, '11111111-1111-4111-8111-111111111111'::uuid,
    'From the owner: please buy the other brand.', NULL, '+12025691377', 'Christopher',
    'a1000000-0000-4000-8000-000000000001'::uuid
  );

  SELECT person_id INTO v_person_id FROM public.messages WHERE id = v_reserve.message_id;
  SELECT person_id INTO v_delivery_person_id FROM public.whatsapp_deliveries WHERE id = v_reserve.delivery_id;
  IF v_person_id IS DISTINCT FROM 'a1000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL: reserve_custom_instruction must write person_id into messages — this is the exact PR #243 worker-notification identity contract';
  END IF;
  IF v_delivery_person_id IS DISTINCT FROM 'a1000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL: reserve_custom_instruction must write person_id into whatsapp_deliveries';
  END IF;
  RAISE NOTICE 'PASS: 3b. reserve_custom_instruction genuinely threads canonical person_id into both messages and whatsapp_deliveries at the real database layer';

  -- Capture task_id BEFORE deletion so the durability assertion below is
  -- not vacuously true (i.e. the column was never linked in the first
  -- place, so "IS NULL after delete" would trivially pass either way).
  SELECT task_id INTO v_task_id FROM public.messages WHERE id = v_reserve.message_id;
  IF v_task_id IS DISTINCT FROM 'a6000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL: messages.task_id must actually be linked to the task before deletion, or the durability assertion below proves nothing (got %)', v_task_id;
  END IF;

  -- Durability: task deletion nulls messages.task_id (ON DELETE SET NULL,
  -- proven from carson_tier1_bootstrap_extension.sql's DDL) but person_id
  -- survives — the same durable-identity contract as section 2b, now also
  -- proven for messages. This DO block runs as the connecting superuser
  -- (no SET ROLE active), which bypasses RLS the same way service_role
  -- does in production, so no role switch is needed for the DELETE itself.
  DELETE FROM public.tasks WHERE id = 'a6000000-0000-4000-8000-000000000001';

  SELECT task_id, person_id INTO v_task_id, v_person_id FROM public.messages WHERE id = v_reserve.message_id;
  IF v_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: messages.task_id should be NULL after the linked task was deleted';
  END IF;
  IF v_person_id IS DISTINCT FROM 'a1000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL: messages.person_id must survive task deletion';
  END IF;
  RAISE NOTICE 'PASS: 3c. person identity survives the relevant current lifecycle (task deletion) exactly as Communication History requires';
END $$;

-- =========================================================================
-- 4. staff_escalation_owner_decisions — task-based RPC chain
-- =========================================================================
-- Reuses the exact real, unmodified RPCs (claim_task_escalation_owner_decision,
-- reserve_custom_instruction — already proven above for the person_id
-- contract, reserve_send_window, complete_custom_instruction). The
-- staff-message-triggered path (claim_escalation_owner_decision) already
-- has comprehensive real-Postgres coverage in
-- staff-escalation-migration-verification.yml — reused by reference, not
-- rebuilt here. This section covers the task-based path
-- (claim_task_escalation_owner_decision), which had no real-Postgres
-- verification before this phase.

SET ROLE service_role;
INSERT INTO public.tasks (id, user_id, description, status, assigned_to, quality_review_status, quality_reviewed_at)
VALUES ('a7000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
        'task-based escalation task', 'pending', 'Christopher', 'substitute_review', '2026-08-14T11:00:00Z');
RESET ROLE;

DO $$
DECLARE
  v_tclaim  staff_escalation_owner_decisions;
  v_tclaim2 staff_escalation_owner_decisions;
  v_caught  boolean;
BEGIN
  v_tclaim := public.claim_task_escalation_owner_decision(
    'a7000000-0000-4000-8000-000000000001'::uuid, '11111111-1111-4111-8111-111111111111'::uuid,
    'substitute_review', 'a1000000-0000-4000-8000-000000000001'::uuid
  );
  IF v_tclaim.person_id IS DISTINCT FROM 'a1000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL: claim_task_escalation_owner_decision must persist canonical person_id — the exact PR #235-followup gap this migration closed';
  END IF;
  RAISE NOTICE 'PASS: 4a. claim_task_escalation_owner_decision — valid claim persists canonical person_id (decision_id=%)', v_tclaim.id;

  -- Duplicate claim protection: a second claim for the same open task
  -- reuses the existing row rather than creating a second one.
  v_tclaim2 := public.claim_task_escalation_owner_decision(
    'a7000000-0000-4000-8000-000000000001'::uuid, '11111111-1111-4111-8111-111111111111'::uuid,
    'substitute_review', 'a1000000-0000-4000-8000-000000000001'::uuid
  );
  IF v_tclaim2.id IS DISTINCT FROM v_tclaim.id THEN
    RAISE EXCEPTION 'FAIL: a duplicate claim for the same open task must reuse the existing decision row, not create a second one';
  END IF;
  IF (SELECT count(*) FROM public.staff_escalation_owner_decisions WHERE task_id = 'a7000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'FAIL: exactly one escalation row should exist for this task';
  END IF;
  RAISE NOTICE 'PASS: 4b. duplicate claim/decision protection — a second claim reuses the same row, no double-escalation created';

  -- Cross-account rejection: a different user cannot claim against owner_a's task.
  v_caught := false;
  BEGIN
    PERFORM public.claim_task_escalation_owner_decision(
      'a7000000-0000-4000-8000-000000000001'::uuid, '22222222-2222-4222-8222-222222222222'::uuid,
      'substitute_review', NULL
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '28000' THEN
      RAISE EXCEPTION 'FAIL: expected not_authorized (28000) for cross-account claim, got %', SQLSTATE;
    END IF;
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: owner_b should not be able to claim an escalation against owner_a''s task';
  END IF;
  RAISE NOTICE 'PASS: 4c. cross-account isolation — a different user cannot claim against another owner''s task (SQLSTATE 28000)';

  -- Scope note: claim_task_escalation_owner_decision's row on
  -- staff_escalation_owner_decisions is the owner-NOTIFY leg (recording
  -- that a review is needed) — it has no lease_token field and is not
  -- chained into reserve_custom_instruction/complete_custom_instruction.
  -- Those RPCs operate on the separate quality_substitute_decisions table
  -- (the actual decision-PROCESSING leg, api/task-confirm.js's
  -- handleOwnerDecision), already proven end-to-end in section 3 above
  -- (claim_substitute_decision -> reserve_custom_instruction). Chaining
  -- this claim's result into that other table's RPCs would test behavior
  -- production never exercises — exactly the kind of invented-contract
  -- risk this phase's instructions warn against. This is precisely the
  -- Phase 0 Incident 3 shape: two independently-implemented legs (owner-
  -- notify here, worker-notify/decision-processing in section 3) that can
  -- regress independently — each is proven against its own real RPCs, not
  -- artificially merged into one chain that doesn't exist in production.
END $$;

-- Unauthorized direct behavior is rejected: authenticated/anon cannot
-- EXECUTE claim_task_escalation_owner_decision at all. Kept as a separate
-- top-level statement (not inside the block above) because it needs a real
-- role switch (SET ROLE), which changes the calling privilege context for
-- the RPC's own internal SECURITY DEFINER check — cleanest done outside any
-- single larger transaction-scoped block.
SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.claim_task_escalation_owner_decision(
      'a7000000-0000-4000-8000-000000000001'::uuid, '11111111-1111-4111-8111-111111111111'::uuid,
      'substitute_review', NULL
    );
    RAISE EXCEPTION 'FAIL: authenticated should not have EXECUTE on claim_task_escalation_owner_decision';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'PASS: 4d. unauthorized direct behavior rejected — authenticated has no EXECUTE grant on the SECURITY DEFINER RPC, only service_role'; END $$;

SELECT 'Carson Tier 1 real-PostgreSQL database contract verification passed' AS result;
