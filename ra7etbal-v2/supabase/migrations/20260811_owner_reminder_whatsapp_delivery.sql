/*
 * One canonical reminder task may create one owner WhatsApp delivery lifecycle.
 * The partial unique index is the durable claim shared by QStash, the safety
 * net, retries, reconciliation, and concurrent serverless invocations.
 */

ALTER TABLE public.whatsapp_deliveries
  DROP CONSTRAINT IF EXISTS whatsapp_deliveries_source_type_check;

ALTER TABLE public.whatsapp_deliveries
  ADD CONSTRAINT whatsapp_deliveries_source_type_check
  CHECK (source_type IN (
    'delegation',
    'message',
    'followup',
    'routine_delegation',
    'routine_message',
    'automation_delegation',
    'automation_message',
    'image',
    'owner_reminder'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_deliveries_owner_reminder_task_uidx
  ON public.whatsapp_deliveries (task_id)
  WHERE source_type = 'owner_reminder' AND task_id IS NOT NULL;
