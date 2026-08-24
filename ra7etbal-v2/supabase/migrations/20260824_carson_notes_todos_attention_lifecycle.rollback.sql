DROP INDEX IF EXISTS public.carson_notes_user_dismissed_created;

DROP POLICY IF EXISTS "Users can update their own Carson notes" ON public.carson_notes;
REVOKE UPDATE ON public.carson_notes FROM authenticated;

ALTER TABLE public.carson_notes DROP COLUMN IF EXISTS dismissed_at;
ALTER TABLE public.carson_notes DROP COLUMN IF EXISTS last_surfaced_at;

ALTER TABLE public.carson_todos DROP COLUMN IF EXISTS last_surfaced_at;
