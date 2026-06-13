-- Morning Brief V2: per-user local time scheduling
-- Adds four columns to profiles so every user gets their brief
-- at their own local morning time instead of a global UTC cron.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS morning_brief_timezone       text        NOT NULL DEFAULT 'Europe/Istanbul',
  ADD COLUMN IF NOT EXISTS morning_brief_time           text        NOT NULL DEFAULT '08:00',
  ADD COLUMN IF NOT EXISTS morning_brief_enabled        boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_morning_brief_sent_at   timestamptz          DEFAULT null;
