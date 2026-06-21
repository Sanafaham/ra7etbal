-- WhatsApp consent audit log.
-- Records every opt-in, opt-out, and onboarding message event per person.
-- Provides Meta-grade evidence: timestamp, source, and raw reply body.

CREATE TABLE IF NOT EXISTS whatsapp_consent_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id        uuid        NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event            text        NOT NULL CHECK (event IN ('opt_in', 'opt_out', 'onboarding_sent', 'reminder_sent')),
  source           text        NOT NULL CHECK (source IN ('owner_toggle', 'staff_reply', 'system')),
  raw_message      text,
  whatsapp_msg_id  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_consent_log ENABLE ROW LEVEL SECURITY;

-- Owners can read their own consent log entries.
CREATE POLICY "Users can read own consent log"
  ON whatsapp_consent_log FOR SELECT
  USING (auth.uid() = user_id);

-- Only the service role can insert (webhook handler uses service key).
-- No INSERT policy needed for authenticated role.

CREATE INDEX IF NOT EXISTS whatsapp_consent_log_person_id_idx ON whatsapp_consent_log (person_id);
CREATE INDEX IF NOT EXISTS whatsapp_consent_log_user_id_idx   ON whatsapp_consent_log (user_id);
CREATE INDEX IF NOT EXISTS whatsapp_consent_log_created_at_idx ON whatsapp_consent_log (created_at DESC);
