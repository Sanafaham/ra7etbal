/**
 * One-time, guarded, idempotent backfill for messages/whatsapp_deliveries
 * rows created by the pre-fix reserve_custom_instruction/
 * reserve_rejected_alternative RPCs (approved_alternative/
 * rejected_alternative/custom_instruction owner-decision worker
 * notifications), where person_id was written NULL because no identity
 * was available at write time.
 *
 * This is a data repair, not a migration -- it only ever UPDATEs existing
 * rows to add a durable identity already provable from surviving,
 * deterministic foreign-key evidence. Never guesses: eligibility requires
 * ALL of --
 *   - the row was created by this exact code path (identified via
 *     quality_substitute_decisions.message_id / .delivery_id, the only
 *     table that links to these RPCs specifically)
 *   - person_id IS NULL (not already set -- makes this safe to re-run)
 *   - the linked task still exists with a non-empty assigned_to
 *   - exactly one people row for that message's user_id case-insensitively
 *     exact-matches assigned_to (zero or ambiguous matches are skipped,
 *     never guessed)
 *
 * Production eligibility, checked read-only before writing this file
 * (2026-08-12, project ggarvhgqzpooloacjgcj): exactly 1 messages row and
 * 1 whatsapp_deliveries row total exist via this join (the RPCs only
 * shipped 2026-07-10/07-12 and organic Approve/Reject/Custom Instruction
 * volume is low) -- both eligible, both belonging to the same test task
 * (f51a864c-5625-4c39-8a37-bd6ea0fc3489, Christopher). Not materially
 * broader than expected.
 *
 * Safe to re-run: every UPDATE is scoped to person_id IS NULL, so a second
 * run after success is a no-op (nothing left to match).
 */

BEGIN;

DO $backfill$
DECLARE
  v_messages_updated int;
  v_deliveries_updated int;
BEGIN
  WITH eligible AS (
    SELECT m.id AS message_id, m.user_id, t.assigned_to
    FROM quality_substitute_decisions qsd
    JOIN messages m ON m.id = qsd.message_id
    JOIN tasks t ON t.id = qsd.task_id
    WHERE m.person_id IS NULL
      AND t.assigned_to IS NOT NULL
      AND t.assigned_to <> ''
  ),
  unambiguous AS (
    SELECT e.message_id, p.id AS person_id
    FROM eligible e
    JOIN people p
      ON p.user_id = e.user_id
     AND lower(trim(p.name)) = lower(trim(e.assigned_to))
    GROUP BY e.message_id, p.id
    HAVING count(*) OVER (PARTITION BY e.message_id) = 1
  )
  UPDATE messages m
  SET person_id = u.person_id
  FROM unambiguous u
  WHERE m.id = u.message_id;
  GET DIAGNOSTICS v_messages_updated = ROW_COUNT;

  WITH eligible AS (
    SELECT wd.id AS delivery_id, wd.user_id, t.assigned_to
    FROM quality_substitute_decisions qsd
    JOIN whatsapp_deliveries wd ON wd.id = qsd.delivery_id
    JOIN tasks t ON t.id = wd.task_id
    WHERE wd.person_id IS NULL
      AND t.assigned_to IS NOT NULL
      AND t.assigned_to <> ''
  ),
  unambiguous AS (
    SELECT e.delivery_id, p.id AS person_id
    FROM eligible e
    JOIN people p
      ON p.user_id = e.user_id
     AND lower(trim(p.name)) = lower(trim(e.assigned_to))
    GROUP BY e.delivery_id, p.id
    HAVING count(*) OVER (PARTITION BY e.delivery_id) = 1
  )
  UPDATE whatsapp_deliveries wd
  SET person_id = u.person_id
  FROM unambiguous u
  WHERE wd.id = u.delivery_id;
  GET DIAGNOSTICS v_deliveries_updated = ROW_COUNT;

  RAISE NOTICE 'worker_notification_person_id_backfill: messages_updated=%, whatsapp_deliveries_updated=%',
    v_messages_updated, v_deliveries_updated;
END
$backfill$;

COMMIT;

-- Auditability: show exactly which rows were recovered.
SELECT m.id AS message_id, m.person_id, m.task_id, t.assigned_to
FROM quality_substitute_decisions qsd
JOIN messages m ON m.id = qsd.message_id
JOIN tasks t ON t.id = qsd.task_id
WHERE m.person_id IS NOT NULL;
