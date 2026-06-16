/**
 * Add "every_n_days" schedule type to routines.
 *
 * New columns:
 *   interval_days  — how many days between runs (required when schedule = 'every_n_days')
 *   next_run_at    — UTC timestamp the runner checks for every_n_days routines;
 *                    stamped on creation and updated after each run
 *
 * The runner (process-delegation-escalations.js) uses next_run_at <= now to decide
 * whether an every_n_days routine is due, then advances next_run_at by interval_days.
 */

ALTER TABLE public.routines
  DROP CONSTRAINT IF EXISTS routines_schedule_check;

ALTER TABLE public.routines
  ADD CONSTRAINT routines_schedule_check
    CHECK (schedule IN ('daily', 'weekly', 'every_n_days'));

ALTER TABLE public.routines
  ADD COLUMN IF NOT EXISTS interval_days int NULL
    CHECK (interval_days IS NULL OR interval_days >= 1);

ALTER TABLE public.routines
  ADD COLUMN IF NOT EXISTS next_run_at timestamptz NULL;
