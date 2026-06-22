/**
 * WhatsApp Delivery Health State V1
 *
 * Stores the latest account-level health snapshot per Ra7etBal owner and Meta
 * phone number. Health evaluation and alerts are intentionally implemented in
 * a later phase; this migration only creates the additive storage boundary.
 *
 * Server-side code writes with the service role. Authenticated owners may read
 * their own row, but cannot insert, update, or delete health state.
 */

CREATE TABLE IF NOT EXISTS public.whatsapp_health_state (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_number_id            text        NOT NULL,

  health_status              text        NOT NULL DEFAULT 'unknown'
                                          CHECK (health_status IN (
                                            'unknown',
                                            'healthy',
                                            'warning',
                                            'degraded'
                                          )),

  last_webhook_received_at   timestamptz NULL,
  last_status_webhook_at     timestamptz NULL,
  last_matched_status_at     timestamptz NULL,

  last_accepted_at           timestamptz NULL,
  last_delivered_at          timestamptz NULL,
  last_failed_at             timestamptz NULL,

  quality_rating             text        NULL,
  phone_number_status        text        NULL,

  degraded_since             timestamptz NULL,
  last_owner_alert_at        timestamptz NULL,
  last_recovery_at           timestamptz NULL,
  last_health_check_at       timestamptz NULL,

  status_reason              jsonb       NOT NULL DEFAULT '{}',

  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT whatsapp_health_state_user_phone_unique
    UNIQUE (user_id, phone_number_id)
);


-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.whatsapp_health_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'whatsapp_health_state'
      AND policyname = 'whatsapp_health_state: owner can select'
  ) THEN
    CREATE POLICY "whatsapp_health_state: owner can select"
      ON public.whatsapp_health_state
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END
$$;

GRANT SELECT ON public.whatsapp_health_state TO authenticated;


-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS whatsapp_health_state_health_idx
  ON public.whatsapp_health_state (health_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS whatsapp_health_state_last_status_webhook_idx
  ON public.whatsapp_health_state (last_status_webhook_at);


-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_whatsapp_health_state_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_whatsapp_health_state_updated_at
  ON public.whatsapp_health_state;

CREATE TRIGGER set_whatsapp_health_state_updated_at
  BEFORE UPDATE ON public.whatsapp_health_state
  FOR EACH ROW
  EXECUTE FUNCTION public.set_whatsapp_health_state_updated_at();
