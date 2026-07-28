/**
 * Rollback for 20260727_owner_whatsapp_reply_receipts.sql.
 *
 * Drops the three new functions, the table (which cascades its own
 * trigger, indexes, and RLS policy), and the shared updated_at trigger
 * function. Nothing else in the schema is touched — no existing table,
 * column, constraint, or function from any prior migration is affected.
 */

DROP FUNCTION IF EXISTS public.fail_owner_whatsapp_reply(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.complete_owner_whatsapp_reply(uuid, uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS public.claim_owner_whatsapp_reply(uuid, text, integer);

DROP TABLE IF EXISTS public.owner_whatsapp_reply_receipts;

DROP FUNCTION IF EXISTS public.set_owner_whatsapp_reply_receipts_updated_at();
