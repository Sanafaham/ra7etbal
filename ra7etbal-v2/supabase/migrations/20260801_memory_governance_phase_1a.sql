-- Memory Governance Phase 1A
-- Adds provenance and freshness tracking to carson_persistent_memory.
--
-- Constitutional basis: COS Ch. 19.3 — Memory Governance must preserve the
-- provenance and age of every stored item. Ch. 19.4 — only Epistemic Governance
-- may write new beliefs to Memory.
--
-- Additive migration only. Existing rows are safe: source defaults to
-- 'owner_directive' and confirmed_at defaults to created_at.

alter table public.carson_persistent_memory
  add column if not exists source text not null default 'owner_directive',
  add column if not exists confirmed_at timestamptz not null default now();

-- Back-fill existing rows: confirmed_at = created_at (the write event is the
-- original confirmation event for pre-existing instructions).
update public.carson_persistent_memory
  set confirmed_at = created_at
  where confirmed_at = now() and created_at < now() - interval '1 second';

comment on column public.carson_persistent_memory.source is
  'Provenance of this instruction — who or what produced it. '
  'owner_directive: explicit user voice/text command. '
  'session_inference: inferred from session context (future use).';

comment on column public.carson_persistent_memory.confirmed_at is
  'Most recent timestamp at which this instruction was actively confirmed '
  'or re-stated by the owner. Used by freshness evaluation to flag stale entries.';
