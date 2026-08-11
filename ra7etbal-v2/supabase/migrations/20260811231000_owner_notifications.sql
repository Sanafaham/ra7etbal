CREATE TABLE public.owner_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  occurred_at timestamptz NOT NULL,
  read_at timestamptz NULL,
  target_type text NULL,
  target_id uuid NULL,
  target_url text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_notifications_user_event_key_key UNIQUE (user_id, event_key)
);

CREATE INDEX owner_notifications_user_occurred_at_idx
  ON public.owner_notifications (user_id, occurred_at DESC);

CREATE INDEX owner_notifications_user_unread_idx
  ON public.owner_notifications (user_id, occurred_at DESC)
  WHERE read_at IS NULL;

ALTER TABLE public.owner_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_notifications: owner can select"
  ON public.owner_notifications FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "owner_notifications: owner can update read state"
  ON public.owner_notifications FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.owner_notifications FROM anon, authenticated;
GRANT SELECT, UPDATE (read_at) ON public.owner_notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.owner_notifications TO service_role;
