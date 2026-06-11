create table public.carson_persistent_memory (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid(),
  category    text        not null default 'general',
  instruction text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.carson_persistent_memory enable row level security;

create policy "Users can select their own persistent memory"
on public.carson_persistent_memory
for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can insert their own persistent memory"
on public.carson_persistent_memory
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can delete their own persistent memory"
on public.carson_persistent_memory
for delete
to authenticated
using (auth.uid() = user_id);

grant select, insert, delete
on public.carson_persistent_memory
to authenticated;

create or replace function public.set_carson_persistent_memory_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_carson_persistent_memory_updated_at
before update on public.carson_persistent_memory
for each row
execute function public.set_carson_persistent_memory_updated_at();
