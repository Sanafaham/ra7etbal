-- Carson Notes: user-authored notes saved via voice.
-- Separate from tasks (action-oriented) and carson_memory (session summaries).
-- These are explicit user captures: ideas, observations, and thoughts.

create table if not exists public.carson_notes (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  note        text        not null,
  category    text        not null default 'general',
  source      text        not null default 'voice',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- RLS: authenticated users can only access their own notes.
alter table public.carson_notes enable row level security;

create policy "Users can select their own Carson notes"
  on public.carson_notes for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert their own Carson notes"
  on public.carson_notes for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can delete their own Carson notes"
  on public.carson_notes for delete
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, delete
on public.carson_notes
to authenticated;

-- Index for fast per-user recency queries.
create index if not exists carson_notes_user_created
  on public.carson_notes (user_id, created_at desc);

create or replace function public.set_carson_notes_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_carson_notes_updated_at
before update on public.carson_notes
for each row
execute function public.set_carson_notes_updated_at();
