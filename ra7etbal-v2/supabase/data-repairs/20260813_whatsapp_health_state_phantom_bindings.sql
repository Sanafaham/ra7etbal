/**
 * One-time, guarded, idempotent removal of the two proven phantom
 * whatsapp_health_state bindings created by the recordWebhookHeartbeat()
 * bug (2026-08-11 16:56:07 UTC) -- see the companion migration
 * 20260813_whatsapp_health_state_phone_number_unique.sql for full incident
 * context.
 *
 * This is a data repair, not a migration. Deletes only the exact two rows
 * identified by primary key during the read-only investigation, both
 * proven to have zero real delivery activity of their own (all four
 * status timestamps NULL) and no foreign-key dependents anywhere in the
 * schema. Sana's canonical row (1d0ee9c5-..., created 2026-06-23, the
 * only row with real activity) is never touched.
 *
 * Guarded: the WHERE clause requires the exact id AND the exact phantom
 * signature (person_id NULL activity, matching phone_number_id) so this
 * can never accidentally delete a different or newer legitimate row that
 * happens to reuse these ids (it won't, ids are gen_random_uuid()) or any
 * row that has since gained real activity. Idempotent: deleting an
 * already-deleted row is a no-op.
 */

DELETE FROM public.whatsapp_health_state
WHERE id IN (
  '3487ca26-f861-4a1d-b543-afa6563b9f23',
  '4e470410-b3bb-47ba-ab24-a934eb83ec50'
)
AND phone_number_id = '1196495893537506'
AND last_matched_status_at IS NULL
AND last_accepted_at IS NULL
AND last_delivered_at IS NULL
AND last_failed_at IS NULL;

-- Auditability: confirm exactly one canonical binding remains for this number.
SELECT id, user_id, phone_number_id, created_at
FROM public.whatsapp_health_state
WHERE phone_number_id = '1196495893537506';
