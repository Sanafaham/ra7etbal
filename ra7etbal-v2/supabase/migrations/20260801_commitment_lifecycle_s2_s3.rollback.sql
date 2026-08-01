-- Rollback: Commitment Lifecycle Amendments S2 + S3

drop trigger if exists enforce_commitment_reopen_authority on public.tasks;
drop function if exists public.enforce_reopen_authority();

alter table public.tasks
  drop column if exists uncertain_olg_registered_at,
  drop column if exists uncertain_escalated_at;
