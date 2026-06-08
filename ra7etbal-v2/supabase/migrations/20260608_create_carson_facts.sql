create table public.carson_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  category text not null,
  key text not null,
  value text not null,
  confidence numeric not null default 1.0,
  source text not null default 'conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  archived_at timestamptz,

  constraint carson_facts_confidence_range
    check (confidence >= 0 and confidence <= 1),

  constraint carson_facts_unique_user_category_key
    unique (user_id, category, key)
);

alter table public.carson_facts enable row level security;

create policy "Users can select their own carson facts"
on public.carson_facts
for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can insert their own carson facts"
on public.carson_facts
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can update their own carson facts"
on public.carson_facts
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

grant select, insert, update
on public.carson_facts
to authenticated;

create or replace function public.set_carson_facts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_carson_facts_updated_at
before update on public.carson_facts
for each row
execute function public.set_carson_facts_updated_at();
