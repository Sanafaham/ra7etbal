/**
 * routines — recurring automation rules
 *
 * Each row is one rule owned by a single user.
 * The QStash cron runner reads this table hourly and executes
 * any routine whose schedule is due.
 *
 * type     : "reminder"   → push notification to the owner
 *            "delegation" → WhatsApp message to a linked person
 *
 * schedule : "daily"  → fires every day at schedule_time (local)
 *            "weekly" → fires on schedule_day at schedule_time (local)
 *
 * payload  :
 *   reminder   → { "title": "..." }
 *   delegation → { "person_id": "<uuid>", "message": "..." }
 *
 * timezone : IANA string (e.g. "Europe/Istanbul"), copied from
 *            profiles.morning_brief_timezone at routine creation.
 *            Stored per-routine so the runner is self-contained.
 *
 * last_run_at : stamped on successful execution; used to prevent
 *               double-execution when the cron fires more than once
 *               within a schedule window.
 */

CREATE TABLE IF NOT EXISTS public.routines (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name          text        NOT NULL,

  type          text        NOT NULL
                  CHECK (type IN ('reminder', 'delegation')),

  schedule      text        NOT NULL
                  CHECK (schedule IN ('daily', 'weekly')),

  -- 0 = Sunday … 6 = Saturday; NULL for daily routines
  schedule_day  int         NULL
                  CHECK (schedule_day IS NULL OR schedule_day BETWEEN 0 AND 6),

  -- "HH:MM" 24-hour local time, e.g. "08:30"
  schedule_time text        NOT NULL
                  CHECK (schedule_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),

  timezone      text        NOT NULL DEFAULT 'UTC',

  payload       jsonb       NOT NULL DEFAULT '{}',

  enabled       boolean     NOT NULL DEFAULT true,

  last_run_at   timestamptz NULL,

  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.routines ENABLE ROW LEVEL SECURITY;

-- Owners have full access to their own routines; no other user can read or write.
CREATE POLICY "routines: owner full access"
  ON public.routines
  FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Runner query: fetch all enabled routines efficiently.
CREATE INDEX IF NOT EXISTS routines_enabled_idx
  ON public.routines (user_id, enabled, schedule_time)
  WHERE enabled = true;
