-- Add WhatsApp consent fields to people table.
-- Consent is off by default for all existing rows.
-- The owner must explicitly check the box in the People profile for each person.

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS whatsapp_opted_in     boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_consent_at   timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_consent_method text
    CHECK (whatsapp_consent_method IN ('owner_confirmed', 'self_registered'));
