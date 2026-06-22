/**
 * WhatsApp Delivery Infrastructure V1
 *
 * One row represents one outbound WhatsApp transport artifact.
 * Resends and follow-ups create new rows. A separate image send can be linked
 * to its parent template delivery through parent_delivery_id.
 *
 * Server-side code writes with the service role. Authenticated owners may read
 * their own rows, but cannot insert, update, or delete delivery evidence.
 */

CREATE TABLE IF NOT EXISTS public.whatsapp_deliveries (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Optional business links. Delivery evidence survives deletion of the
  -- user-facing message/task/routine/run that initiated it.
  message_id          uuid        NULL REFERENCES public.messages(id) ON DELETE SET NULL,
  task_id             uuid        NULL REFERENCES public.tasks(id) ON DELETE SET NULL,
  routine_id          uuid        NULL REFERENCES public.routines(id) ON DELETE SET NULL,
  automation_run_id   uuid        NULL REFERENCES public.automation_runs(id) ON DELETE SET NULL,
  parent_delivery_id  uuid        NULL REFERENCES public.whatsapp_deliveries(id) ON DELETE SET NULL,

  source_type         text        NOT NULL
                                  CHECK (source_type IN (
                                    'delegation',
                                    'message',
                                    'followup',
                                    'routine_delegation',
                                    'routine_message',
                                    'automation_delegation',
                                    'automation_message',
                                    'image'
                                  )),

  message_kind        text        NOT NULL DEFAULT 'template'
                                  CHECK (message_kind IN ('template', 'image')),

  recipient_phone     text        NULL,
  recipient_name      text        NULL,
  template_name       text        NULL,

  -- Meta's WhatsApp message id (wamid). NULL before acceptance or after an
  -- immediate failure.
  meta_message_id     text        NULL,

  delivery_status     text        NOT NULL DEFAULT 'pending'
                                  CHECK (delivery_status IN (
                                    'pending',
                                    'accepted',
                                    'sent',
                                    'delivered',
                                    'read',
                                    'failed'
                                  )),

  accepted_at         timestamptz NULL,
  sent_at             timestamptz NULL,
  delivered_at        timestamptz NULL,
  read_at             timestamptz NULL,
  failed_at           timestamptz NULL,
  last_status_at      timestamptz NULL,

  failure_stage       text        NULL
                                  CHECK (
                                    failure_stage IS NULL OR
                                    failure_stage IN (
                                      'validation',
                                      'configuration',
                                      'meta_api',
                                      'network',
                                      'storage'
                                    )
                                  ),
  failure_http_status integer     NULL,
  failure_code        text        NULL,
  failure_subcode     text        NULL,
  failure_reason      text        NULL,

  -- Safe operational details only: template attempt count, accepted attempt,
  -- template language, and similar non-secret diagnostics.
  metadata            jsonb       NOT NULL DEFAULT '{}',

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);


-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.whatsapp_deliveries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'whatsapp_deliveries'
      AND policyname = 'whatsapp_deliveries: owner can select'
  ) THEN
    CREATE POLICY "whatsapp_deliveries: owner can select"
      ON public.whatsapp_deliveries
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END
$$;

GRANT SELECT ON public.whatsapp_deliveries TO authenticated;


-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_deliveries_meta_message_id_uidx
  ON public.whatsapp_deliveries (meta_message_id)
  WHERE meta_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS whatsapp_deliveries_user_created_idx
  ON public.whatsapp_deliveries (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS whatsapp_deliveries_status_created_idx
  ON public.whatsapp_deliveries (delivery_status, created_at);

CREATE INDEX IF NOT EXISTS whatsapp_deliveries_task_idx
  ON public.whatsapp_deliveries (task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS whatsapp_deliveries_automation_run_idx
  ON public.whatsapp_deliveries (automation_run_id)
  WHERE automation_run_id IS NOT NULL;


-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_whatsapp_deliveries_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_whatsapp_deliveries_updated_at
  ON public.whatsapp_deliveries;

CREATE TRIGGER set_whatsapp_deliveries_updated_at
  BEFORE UPDATE ON public.whatsapp_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_whatsapp_deliveries_updated_at();
