-- Rollback: Memory Governance Phase 1A
alter table public.carson_persistent_memory
  drop column if exists source,
  drop column if exists confirmed_at;
