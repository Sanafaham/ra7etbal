\set ON_ERROR_STOP on

-- Proves the real Postgres RLS SELECT-isolation boundary that
-- get_items_needing_attention (attention_summary_read) depends on for its
-- four underlying data sources: public.tasks, public.staff_messages,
-- public.automations, public.automation_runs.
--
-- This proves the DB-level boundary only — that Owner A's SELECT, under
-- the real production RLS policies, structurally cannot return Owner B's
-- row, for every table the capability reads. It does NOT re-prove the
-- TypeScript composition layer (fetchAttentionEvidence takes no
-- caller-suppliable identity parameter — that is a separate, existing
-- property already covered by
-- src/lib/carson-operations-center.attention-summary.test.ts's tenant-
-- isolation test). Together, the two constitute the full chain: DB
-- boundary (this file) + deterministic composition (the Vitest test) +
-- identity source is solely supabase.auth.getUser() (also the Vitest
-- test). Neither alone is claimed as the whole proof.

-- ── public.tasks ─────────────────────────────────────────────────────────

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; -- owner_a

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tasks WHERE id = 'b0000000-0000-4000-8000-00000000b001'
  ) THEN
    RAISE EXCEPTION 'FAIL tasks: owner_a cannot see own task';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tasks WHERE id = 'b0000000-0000-4000-8000-00000000b002'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT tasks: owner_a SELECT returned owner_b row';
  END IF;
  IF (SELECT count(*) FROM public.tasks) <> 1 THEN
    RAISE EXCEPTION 'SECURITY DEFECT tasks: owner_a SELECT returned more than owner_a''s own row(s)';
  END IF;
END $$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; -- owner_b

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tasks WHERE id = 'b0000000-0000-4000-8000-00000000b002'
  ) THEN
    RAISE EXCEPTION 'FAIL tasks: owner_b cannot see own task';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tasks WHERE id = 'b0000000-0000-4000-8000-00000000b001'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT tasks: owner_b SELECT returned owner_a row';
  END IF;
END $$;

RESET ROLE;

-- ── public.staff_messages (the exact table listOpenStaffEscalationsForNeedsYou() queries) ──

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; -- owner_a

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.staff_messages WHERE id = 'c0000000-0000-4000-8000-00000000c001'
  ) THEN
    RAISE EXCEPTION 'FAIL staff_messages: owner_a cannot see own message';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.staff_messages WHERE id = 'c0000000-0000-4000-8000-00000000c002'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT staff_messages: owner_a SELECT returned owner_b row';
  END IF;
  IF (SELECT count(*) FROM public.staff_messages) <> 1 THEN
    RAISE EXCEPTION 'SECURITY DEFECT staff_messages: owner_a SELECT returned more than owner_a''s own row(s)';
  END IF;
END $$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; -- owner_b

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.staff_messages WHERE id = 'c0000000-0000-4000-8000-00000000c002'
  ) THEN
    RAISE EXCEPTION 'FAIL staff_messages: owner_b cannot see own message';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.staff_messages WHERE id = 'c0000000-0000-4000-8000-00000000c001'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT staff_messages: owner_b SELECT returned owner_a row';
  END IF;
END $$;

RESET ROLE;

-- ── public.automations (the exact table fetchAutomationDigest() queries) ───

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; -- owner_a

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.automations WHERE id = 'd0000000-0000-4000-8000-00000000d001'
  ) THEN
    RAISE EXCEPTION 'FAIL automations: owner_a cannot see own automation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.automations WHERE id = 'd0000000-0000-4000-8000-00000000d002'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT automations: owner_a SELECT returned owner_b row';
  END IF;
  IF (SELECT count(*) FROM public.automations) <> 1 THEN
    RAISE EXCEPTION 'SECURITY DEFECT automations: owner_a SELECT returned more than owner_a''s own row(s)';
  END IF;
END $$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; -- owner_b

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.automations WHERE id = 'd0000000-0000-4000-8000-00000000d002'
  ) THEN
    RAISE EXCEPTION 'FAIL automations: owner_b cannot see own automation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.automations WHERE id = 'd0000000-0000-4000-8000-00000000d001'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT automations: owner_b SELECT returned owner_a row';
  END IF;
END $$;

RESET ROLE;

-- ── public.automation_runs (also queried directly by fetchAutomationDigest(),
--    joined to automations!inner) ────────────────────────────────────────

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; -- owner_a

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.automation_runs WHERE id = 'e0000000-0000-4000-8000-00000000e001'
  ) THEN
    RAISE EXCEPTION 'FAIL automation_runs: owner_a cannot see own run';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.automation_runs WHERE id = 'e0000000-0000-4000-8000-00000000e002'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT automation_runs: owner_a SELECT returned owner_b row';
  END IF;
  IF (SELECT count(*) FROM public.automation_runs) <> 1 THEN
    RAISE EXCEPTION 'SECURITY DEFECT automation_runs: owner_a SELECT returned more than owner_a''s own row(s)';
  END IF;
END $$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; -- owner_b

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.automation_runs WHERE id = 'e0000000-0000-4000-8000-00000000e002'
  ) THEN
    RAISE EXCEPTION 'FAIL automation_runs: owner_b cannot see own run';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.automation_runs WHERE id = 'e0000000-0000-4000-8000-00000000e001'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT automation_runs: owner_b SELECT returned owner_a row';
  END IF;
END $$;

RESET ROLE;

-- ── public.carson_notes (the exact table loadUnresolvedNotes()/
--    fetchUnresolvedCaptureCandidates() queries) ─────────────────────────────

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; -- owner_a

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.carson_notes WHERE id = 'f0000000-0000-4000-8000-00000000f001'
  ) THEN
    RAISE EXCEPTION 'FAIL carson_notes: owner_a cannot see own note';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.carson_notes WHERE id = 'f0000000-0000-4000-8000-00000000f002'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT carson_notes: owner_a SELECT returned owner_b row';
  END IF;
  IF (SELECT count(*) FROM public.carson_notes) <> 1 THEN
    RAISE EXCEPTION 'SECURITY DEFECT carson_notes: owner_a SELECT returned more than owner_a''s own row(s)';
  END IF;
END $$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; -- owner_b

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.carson_notes WHERE id = 'f0000000-0000-4000-8000-00000000f002'
  ) THEN
    RAISE EXCEPTION 'FAIL carson_notes: owner_b cannot see own note';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.carson_notes WHERE id = 'f0000000-0000-4000-8000-00000000f001'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT carson_notes: owner_b SELECT returned owner_a row';
  END IF;
END $$;

RESET ROLE;

-- ── carson_notes UPDATE policy (new in this PR — dismissed_at/
--    last_surfaced_at writes) — owner can update own row; cannot update
--    another owner's row. A UPDATE whose target row isn't visible affects
--    zero rows (not an exception) — verified by row count and by
--    confirming the value is genuinely unchanged, not by expecting a
--    thrown error.
--
--    Verified locally (real Postgres, not asserted from documentation
--    alone): Postgres enforces UPDATE row-visibility through the SELECT
--    policy first (an UPDATE must "see" a row via SELECT-equivalent
--    visibility before its own USING/WITH CHECK is even evaluated) — a
--    negative control that weakened ONLY the new UPDATE policy to
--    USING(true)/WITH CHECK(true) still correctly returned 0 rows
--    affected against owner_b's note, proving the pre-existing SELECT
--    policy (verified further up this file) already fully gates this
--    too. This is defense in depth, not a redundant check: it directly
--    proves the actual owner-scoped UPDATE behavior this migration adds,
--    regardless of which specific policy is doing the enforcing. ─────────

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; -- owner_a

DO $$
BEGIN
  UPDATE public.carson_notes SET dismissed_at = now()
  WHERE id = 'f0000000-0000-4000-8000-00000000f001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL carson_notes: owner_a could not update own note';
  END IF;
END $$;

DO $$
BEGIN
  UPDATE public.carson_notes SET note = 'tampered by owner_a'
  WHERE id = 'f0000000-0000-4000-8000-00000000f002';
  IF FOUND THEN
    RAISE EXCEPTION 'SECURITY DEFECT carson_notes: owner_a UPDATE affected owner_b''s row';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.carson_notes
    WHERE id = 'f0000000-0000-4000-8000-00000000f002' AND note = 'tampered by owner_a'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT carson_notes: owner_b''s note content was modified by owner_a';
  END IF;
END $$;

RESET ROLE;

-- ── public.carson_todos (the exact table listActiveTodosWithSurfaceState()
--    queries) ─────────────────────────────────────────────────────────────

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; -- owner_a

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.carson_todos WHERE id = 'a1000000-0000-4000-8000-00000000a101'
  ) THEN
    RAISE EXCEPTION 'FAIL carson_todos: owner_a cannot see own todo';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.carson_todos WHERE id = 'a1000000-0000-4000-8000-00000000a102'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT carson_todos: owner_a SELECT returned owner_b row';
  END IF;
  IF (SELECT count(*) FROM public.carson_todos) <> 1 THEN
    RAISE EXCEPTION 'SECURITY DEFECT carson_todos: owner_a SELECT returned more than owner_a''s own row(s)';
  END IF;
END $$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; -- owner_b

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.carson_todos WHERE id = 'a1000000-0000-4000-8000-00000000a102'
  ) THEN
    RAISE EXCEPTION 'FAIL carson_todos: owner_b cannot see own todo';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.carson_todos WHERE id = 'a1000000-0000-4000-8000-00000000a101'
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFECT carson_todos: owner_b SELECT returned owner_a row';
  END IF;
END $$;

RESET ROLE;

-- ── No caller-supplied identifier can override authenticated identity ──────
-- auth.uid() reads only request.jwt.claim.sub (the session's own JWT
-- claim) — there is no column, parameter, or query filter through which a
-- client-supplied value substitutes for it. This is a structural property
-- of every policy above (each USING/WITH CHECK clause references
-- auth.uid() directly, never a client-supplied column), not a separate
-- runtime check to execute.

SELECT 'attention_summary_rls verification passed — tasks, staff_messages, automations, automation_runs, carson_notes, carson_todos cross-owner SELECT isolation confirmed both directions, plus carson_notes UPDATE policy' AS result;
