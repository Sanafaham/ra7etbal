-- Clear My Head Inbox: where reviewed-but-undecided thoughts land when the
-- user presses "Leave here for now" in Clear My Head Review, instead of being
-- lost when the extraction store clears. Read-only in the UI (delete only) —
-- distinct from carson_notes/carson_todos/tasks/messages, which are Carson's
-- own created objects. A thought only becomes one of those if the user later
-- asks Carson to convert it.

create table if not exists public.clear_my_head_inbox (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  text        text        not null,
  created_at  timestamptz not null default now()
);

-- RLS: authenticated users can only access their own inbox thoughts.
alter table public.clear_my_head_inbox enable row level security;

drop policy if exists "Users can select their own Clear My Head inbox"
  on public.clear_my_head_inbox;

create policy "Users can select their own Clear My Head inbox"
  on public.clear_my_head_inbox for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own Clear My Head inbox"
  on public.clear_my_head_inbox;

create policy "Users can insert their own Clear My Head inbox"
  on public.clear_my_head_inbox for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own Clear My Head inbox"
  on public.clear_my_head_inbox;

create policy "Users can delete their own Clear My Head inbox"
  on public.clear_my_head_inbox for delete
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, delete
on public.clear_my_head_inbox
to authenticated;

-- Index for fast per-user recency queries.
create index if not exists clear_my_head_inbox_user_created
  on public.clear_my_head_inbox (user_id, created_at desc);
