/**
 * One-time, guarded, idempotent backfill for whatsapp_deliveries rows
 * created by the pre-fix automation runner (process-delegation-escalations.js
 * automation_delegation / automation_message sends), where person_id was
 * written NULL because the already-resolved canonical assignee identity was
 * never threaded into the send-whatsapp-task payload (fixed going forward by
 * threading assignee.id / person.id as personId end to end).
 *
 * This is a data repair, not a migration -- it only ever UPDATEs existing
 * rows to add a durable identity already provable from surviving,
 * deterministic foreign-key evidence. Never guesses: eligibility requires
 * ALL of --
 *   - whatsapp_deliveries.person_id IS NULL (not already set -- makes this
 *     safe to re-run)
 *   - whatsapp_deliveries.automation_run_id IS NOT NULL (only automation-
 *     created deliveries are in scope)
 *   - the linked automation_runs row exists and its automation_id resolves
 *     to an automations row with a non-null assignee_id
 *   - ownership is consistent end to end: whatsapp_deliveries.user_id =
 *     automation_runs.user_id = automations.user_id = people.user_id (no
 *     cross-account attribution)
 *   - the assignee_id matches a people row's primary key exactly (a direct
 *     UUID foreign-key join, not a name match -- so there is no possibility
 *     of an ambiguous match; a dangling assignee_id with no matching people
 *     row under that ownership scope is simply excluded by the JOIN, never
 *     guessed)
 *   - no name matching anywhere -- only UUID foreign-key joins
 *
 * Production eligibility, checked read-only before writing this file
 * (2026-08-13, project ggarvhgqzpooloacjgcj):
 *   SELECT count(*) FROM whatsapp_deliveries
 *   WHERE person_id IS NULL AND automation_run_id IS NOT NULL;
 * returned 6 rows. All 6 were independently joined through
 * automation_runs -> automations -> people and confirmed to have a fully
 * consistent, unambiguous ownership chain (Category A: deterministically
 * attributable), including the historical PR #236 automation event
 * (delivery ec6900b3-0edf-4c2c-a5c1-8e21619fe969, assignee Christopher).
 * Zero ambiguous (Category B) or already-attributable via another path
 * (Category C) rows were found.
 *
 * Safe to re-run: every UPDATE is scoped to person_id IS NULL, so a second
 * run after success is a no-op (nothing left to match).
 */

BEGIN;

DO $backfill$
DECLARE
  v_deliveries_updated int;
BEGIN
  WITH eligible AS (
    SELECT
      wd.id AS delivery_id,
      p.id AS person_id
    FROM whatsapp_deliveries wd
    JOIN automation_runs ar ON ar.id = wd.automation_run_id
    JOIN automations a ON a.id = ar.automation_id
    JOIN people p ON p.user_id = wd.user_id AND p.id = a.assignee_id
    WHERE wd.person_id IS NULL
      AND wd.automation_run_id IS NOT NULL
      AND ar.user_id = wd.user_id
      AND a.user_id = wd.user_id
      AND a.assignee_id IS NOT NULL
  )
  UPDATE whatsapp_deliveries wd
  SET person_id = e.person_id
  FROM eligible e
  WHERE wd.id = e.delivery_id;
  GET DIAGNOSTICS v_deliveries_updated = ROW_COUNT;

  RAISE NOTICE 'automation_delivery_person_id_backfill: whatsapp_deliveries_updated=%',
    v_deliveries_updated;
END
$backfill$;

COMMIT;

-- Auditability: show exactly which rows were recovered.
SELECT wd.id AS delivery_id, wd.person_id, wd.automation_run_id, wd.task_id
FROM whatsapp_deliveries wd
WHERE wd.automation_run_id IS NOT NULL
  AND wd.person_id IS NOT NULL;
