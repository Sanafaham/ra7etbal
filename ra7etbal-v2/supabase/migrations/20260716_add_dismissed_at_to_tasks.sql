-- Server-backed dismissal state for owner-facing confirmation-notice
-- banners (ConfirmationNotices.tsx). Replaces per-device localStorage
-- dismissal, which could diverge between Safari, an installed PWA, and
-- other devices/logins after a fresh sign-in. Nullable — null means not
-- dismissed; existing rows default to null (nothing was previously
-- dismissed on the server, matching current production behavior).
--
-- No new RLS policy needed: existing owner-scoped policies on tasks
-- already cover this column since Postgres RLS is row-level, not
-- column-level.

alter table public.tasks
  add column if not exists dismissed_at timestamptz;
