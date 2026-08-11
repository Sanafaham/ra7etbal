DROP INDEX IF EXISTS public.whatsapp_deliveries_owner_reminder_task_uidx;

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
    'image'
  ));
