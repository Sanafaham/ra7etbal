-- Persist owner dismissal of completed confirmation banners across web, PWA,
-- logout/login, and devices. Existing rows remain visible until dismissed.
alter table public.tasks
  add column if not exists dismissed_at timestamptz;
