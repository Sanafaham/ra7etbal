-- Carson pending operations: stores proposed plans so they survive voice session
-- disconnect. Cleaned up when completed, cancelled, or expired.

CREATE TABLE IF NOT EXISTS public.carson_pending_operations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('guest_arrival')),
  summary     text NOT NULL,
  tasks       jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_text text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'completed', 'cancelled', 'expired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  completed_at timestamptz NULL
);

ALTER TABLE public.carson_pending_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own pending operations"
  ON public.carson_pending_operations
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for fast lookup of active pending ops per user
CREATE INDEX IF NOT EXISTS carson_pending_operations_user_status
  ON public.carson_pending_operations (user_id, status, expires_at);
