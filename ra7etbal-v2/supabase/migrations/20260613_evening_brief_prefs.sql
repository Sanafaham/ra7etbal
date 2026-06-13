-- Evening Brief V1: optional per-user evening close-of-day notification.
-- Off by default — users opt in. Shares morning_brief_timezone from profiles.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS evening_brief_enabled        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS evening_brief_time           text        NOT NULL DEFAULT '20:00',
  ADD COLUMN IF NOT EXISTS last_evening_brief_sent_at   timestamptz          DEFAULT null;
