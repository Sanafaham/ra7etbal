DROP FUNCTION IF EXISTS public.complete_personal_contact_reply_notification(uuid, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.record_personal_contact_reply(uuid, uuid, text, text, text, text, uuid);
DROP INDEX IF EXISTS public.personal_contact_replies_correlated_delivery_idx;
DROP TABLE IF EXISTS public.personal_contact_replies;
