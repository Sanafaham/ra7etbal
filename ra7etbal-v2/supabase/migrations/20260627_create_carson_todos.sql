-- Carson To-dos: active personal commitments — distinct from carson_notes
-- (passive information, ideas, reference material). Additive only; does not
-- touch carson_notes or any other existing table.
--
-- status lifecycle: active -> completed | archived

create table if not exists public.carson_todos (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  title         text        not null,
  description   text,
  status        text        not null default 'active'
                check (status in ('active', 'completed', 'archived')),
  source        text        not null default 'voice',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- RLS: authenticated users can only access their own to-dos.
alter table public.carson_todos enable row level security;

drop policy if exists "Users can select their own Carson todos"
  on public.carson_todos;

create policy "Users can select their own Carson todos"
  on public.carson_todos for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own Carson todos"
  on public.carson_todos;

create policy "Users can insert their own Carson todos"
  on public.carson_todos for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own Carson todos"
  on public.carson_todos;

create policy "Users can update their own Carson todos"
  on public.carson_todos for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own Carson todos"
  on public.carson_todos;

create policy "Users can delete their own Carson todos"
  on public.carson_todos for delete
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete
on public.carson_todos
to authenticated;

-- Index for fast per-user active-list queries.
create index if not exists carson_todos_user_status_created
  on public.carson_todos (user_id, status, created_at desc);

create or replace function public.set_carson_todos_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_carson_todos_updated_at
  on public.carson_todos;

create trigger set_carson_todos_updated_at
before update on public.carson_todos
for each row
execute function public.set_carson_todos_updated_at();
