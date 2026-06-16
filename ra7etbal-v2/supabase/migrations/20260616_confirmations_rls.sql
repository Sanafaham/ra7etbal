-- Enable RLS on public.confirmations.
--
-- The only writer is the server-side service role (api/task-confirm.js).
-- The service role bypasses RLS entirely, so no INSERT policy is needed.
-- Anonymous users receive nothing by default (deny-all when RLS is on
-- and no anon policy exists).
-- Authenticated owners can read confirmations that belong to their own tasks.

ALTER TABLE public.confirmations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "confirmations_owner_select"
  ON public.confirmations
  FOR SELECT
  TO authenticated
  USING (
    task_id IN (
      SELECT id FROM public.tasks WHERE user_id = auth.uid()
    )
  );
