ALTER TABLE public.owner_notifications
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS owner_notifications_user_active_idx
  ON public.owner_notifications (user_id, occurred_at DESC)
  WHERE dismissed_at IS NULL;

GRANT UPDATE (dismissed_at) ON public.owner_notifications TO authenticated;
