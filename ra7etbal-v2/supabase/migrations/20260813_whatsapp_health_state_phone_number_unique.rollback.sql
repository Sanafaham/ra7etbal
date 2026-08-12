/**
 * Rollback for 20260813_whatsapp_health_state_phone_number_unique.sql.
 * Removes only the added constraint; the pre-existing
 * UNIQUE (user_id, phone_number_id) constraint and all data are untouched.
 */

ALTER TABLE public.whatsapp_health_state
  DROP CONSTRAINT IF EXISTS whatsapp_health_state_phone_number_id_unique;
