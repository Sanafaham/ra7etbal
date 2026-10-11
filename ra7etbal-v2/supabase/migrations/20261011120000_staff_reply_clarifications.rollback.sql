/**
 * Rollback for 20261011120000_staff_reply_clarifications.sql.
 *
 * Drops the two functions and the table. Nothing else is touched.
 * staff_messages.task_id and staff_escalation_owner_decisions.task_id
 * values filled by resolve_staff_reply_clarification stay in place: each
 * was validated at link time (owner, assignee, pending) and is ordinary
 * task evidence that the existing code already reads.
 */

DROP FUNCTION IF EXISTS public.resolve_staff_reply_clarification(uuid, uuid, uuid, integer, uuid);
DROP FUNCTION IF EXISTS public.open_staff_reply_clarification(uuid, uuid, uuid[], text, integer);
DROP TABLE IF EXISTS public.staff_reply_clarifications;
