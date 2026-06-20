/**
 * Agent Automation Layer — V1
 *
 * Two tables:
 *
 *   automations
 *     The long-lived loop definition. One row per user intent.
 *     Carson creates these from voice or text.
 *     The runner reads this to know what to execute and when.
 *
 *   automation_runs
 *     One execution instance per automation per cadence cycle.
 *     Links to a real task row so existing WhatsApp, confirmation,
 *     follow-up, and escalation logic is reused with no new delivery code.
 *     State machine lives here.
 *
 * Delivery logic, runner, and Carson tools are NOT built in this migration.
 * This file is schema only.
 */


-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: automations
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.automations (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Human-readable label Carson confirms back to the user.
  title               text        NOT NULL,

  -- Raw instruction as the user said it — preserved for Carson to re-parse later.
  instruction         text        NOT NULL,

  -- Who this automation targets. NULL = automation has no assigned person (owner-only loops).
  assignee_id         uuid        NULL REFERENCES public.people(id) ON DELETE SET NULL,

  -- cadence_type examples: 'weekly', 'daily', 'interval_days', 'weekdays'
  cadence_type        text        NOT NULL,

  -- Structured cadence detail.
  -- weekly:       { "day": 5, "time": "09:00" }   (0=Sun … 6=Sat)
  -- daily:        { "time": "09:00" }
  -- interval_days: { "every": 2, "time": "09:00" }
  -- weekdays:     { "time": "09:00" }
  cadence_value       jsonb       NOT NULL DEFAULT '{}',

  -- IANA timezone. Copied from profiles.morning_brief_timezone at creation.
  timezone            text        NOT NULL DEFAULT 'Europe/Istanbul',

  -- Next scheduled execution. Runner queries WHERE next_run_at <= now() AND status = 'active'.
  next_run_at         timestamptz NOT NULL,

  -- Whether this automation expects evidence the task was done.
  proof_required      boolean     NOT NULL DEFAULT false,

  -- Only meaningful when proof_required = true.
  -- NULL = proof not required, or type not yet set.
  proof_type          text        NULL
                        CHECK (proof_type IS NULL OR proof_type IN ('photo', 'confirmation', 'text')),

  -- Minutes after a run is sent before Carson sends a follow-up if no confirmation.
  followup_after_min  integer     NOT NULL DEFAULT 120
                        CHECK (followup_after_min > 0),

  -- Minutes after a run is sent before Carson escalates to the owner.
  escalate_after_min  integer     NOT NULL DEFAULT 360
                        CHECK (escalate_after_min > 0)
                        CHECK (escalate_after_min > followup_after_min),

  -- Lifecycle:
  --   active   → runner will execute this.
  --   paused   → runner skips; paused_reason explains why.
  --   stopped  → permanently disabled by user.
  --   archived → soft-deleted; hidden from UI but preserved for history.
  status              text        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'paused', 'stopped', 'archived')),

  paused_reason       text        NULL,

  -- Who created this automation. 'carson' (voice/text) or 'manual' (future UI).
  created_by          text        NOT NULL DEFAULT 'carson',

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);


-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "automations: owner can select"
  ON public.automations
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "automations: owner can insert"
  ON public.automations
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "automations: owner can update"
  ON public.automations
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- No DELETE policy for V1. Service role can delete via server-side code only.

GRANT SELECT, INSERT, UPDATE
  ON public.automations
  TO authenticated;


-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS automations_user_id_idx
  ON public.automations (user_id);

CREATE INDEX IF NOT EXISTS automations_status_idx
  ON public.automations (status);

-- Primary runner query index: all active automations due to fire.
CREATE INDEX IF NOT EXISTS automations_next_run_at_idx
  ON public.automations (next_run_at)
  WHERE status = 'active';


-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_automations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_automations_updated_at
  BEFORE UPDATE ON public.automations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_automations_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: automation_runs
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.automation_runs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   uuid        NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Links to the real task row created when the run fires.
  -- NULL until the runner creates the task.
  -- SET NULL on task delete so the run record survives if a task is manually removed.
  task_id         uuid        NULL REFERENCES public.tasks(id) ON DELETE SET NULL,

  -- The calendar moment this run is for (e.g. "the Friday 2026-06-20 instance").
  -- Distinct from created_at. Used to de-duplicate if the cron fires twice.
  run_for         timestamptz NOT NULL,

  -- State machine:
  --   scheduled    → created by runner; task not yet sent.
  --   task_created → task row created; WhatsApp not yet sent.
  --   sent         → WhatsApp delivered; waiting for response.
  --   confirmed    → assignee confirmed / proof received.
  --   followup_sent → follow-up WhatsApp sent; still waiting.
  --   escalated    → owner notified; still unresolved.
  --   completed    → loop closed successfully.
  --   failed       → unrecoverable error; failure_reason set.
  --   skipped      → this cycle intentionally skipped (automation paused mid-run, holiday, etc.).
  current_state   text        NOT NULL DEFAULT 'scheduled'
                    CHECK (current_state IN (
                      'scheduled',
                      'task_created',
                      'sent',
                      'confirmed',
                      'followup_sent',
                      'escalated',
                      'completed',
                      'failed',
                      'skipped'
                    )),

  -- Timestamps for each state transition. NULL until that state is reached.
  sent_at             timestamptz NULL,
  confirmed_at        timestamptz NULL,
  followup_sent_at    timestamptz NULL,
  escalated_at        timestamptz NULL,
  completed_at        timestamptz NULL,

  -- Set on failed state. Human-readable reason for Carson to report.
  failure_reason      text        NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Prevent double-execution: only one run per automation per scheduled cycle.
  CONSTRAINT automation_runs_unique_cycle
    UNIQUE (automation_id, run_for)
);


-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;

-- Owners can read their own runs (for Morning Brief, status queries).
-- No client insert or update — runs are created and mutated by the server-side runner only.
CREATE POLICY "automation_runs: owner can select"
  ON public.automation_runs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

GRANT SELECT
  ON public.automation_runs
  TO authenticated;


-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS automation_runs_automation_id_idx
  ON public.automation_runs (automation_id);

CREATE INDEX IF NOT EXISTS automation_runs_user_id_idx
  ON public.automation_runs (user_id);

CREATE INDEX IF NOT EXISTS automation_runs_task_id_idx
  ON public.automation_runs (task_id);

CREATE INDEX IF NOT EXISTS automation_runs_current_state_idx
  ON public.automation_runs (current_state);

-- Runner follow-up/escalation query: open runs that may need action.
CREATE INDEX IF NOT EXISTS automation_runs_run_for_idx
  ON public.automation_runs (run_for)
  WHERE current_state IN ('scheduled', 'task_created', 'sent', 'followup_sent', 'escalated');


-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_automation_runs_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_automation_runs_updated_at
  BEFORE UPDATE ON public.automation_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_automation_runs_updated_at();
