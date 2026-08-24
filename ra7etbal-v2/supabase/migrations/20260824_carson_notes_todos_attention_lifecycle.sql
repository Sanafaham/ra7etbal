-- Second Brain Phase 1 — unresolved-capture lifecycle fields for carson_notes
-- and carson_todos, so get_items_needing_attention (attention_summary_read)
-- can ground answers in Notes/To-dos without re-surfacing an item forever
-- or after it has been converted into another operational object.
--
-- carson_notes:
--   dismissed_at      — set when a note is converted into a task, reminder,
--                       delegation, or calendar event (deduplication: the
--                       note itself stops being "unresolved" once another
--                       real operational object represents the same intent).
--                       Never set on plain deletion — deleteCarsonNote()
--                       already removes the row entirely; dismissed_at is
--                       for the "represented elsewhere, but keep the
--                       original text as history" case only.
--   last_surfaced_at  — set only when the note was actually included in a
--                       rendered get_items_needing_attention response handed
--                       back to Carson (not merely retrieved and then
--                       filtered out by relevance classification).
--
-- carson_todos:
--   last_surfaced_at  — same semantics as above. No dismissed_at needed:
--                       carson_todos already has a status lifecycle
--                       (active -> completed | archived) that carries this
--                       meaning for to-dos.
--
-- Additive only. No existing column, policy, or row is changed.

alter table public.carson_notes
  add column if not exists dismissed_at timestamptz,
  add column if not exists last_surfaced_at timestamptz;

alter table public.carson_todos
  add column if not exists last_surfaced_at timestamptz;

-- carson_notes previously had no UPDATE policy at all (select/insert/delete
-- only) — the dismissed_at/last_surfaced_at writes above require one. Scoped
-- identically to every other owner-scoped UPDATE policy in this codebase.
drop policy if exists "Users can update their own Carson notes"
  on public.carson_notes;

create policy "Users can update their own Carson notes"
  on public.carson_notes for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant update
on public.carson_notes
to authenticated;

-- Index for the new retrieval query (unresolved notes, most recent first).
create index if not exists carson_notes_user_dismissed_created
  on public.carson_notes (user_id, dismissed_at, created_at desc);
