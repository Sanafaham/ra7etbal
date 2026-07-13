-- Type to Carson conversation history.
--
-- Additive only. This table does not change voice sessions, tasks, messages,
-- WhatsApp delivery, confirmations, or any existing Carson memory table.
-- Exact typed turns are stored separately from carson_memory, which remains
-- the source of durable session summaries and facts.

create table if not exists public.carson_typed_messages (
  id                         uuid        primary key default gen_random_uuid(),
  user_id                    uuid        not null default auth.uid()
                                         references auth.users(id) on delete cascade,
  session_id                 uuid        not null,
  client_message_id          uuid,
  reply_to_client_message_id uuid,
  role                       text        not null
                                         check (role in ('user', 'agent')),
  content                    text        not null
                                         check (char_length(btrim(content)) between 1 and 12000),
  delivery_status            text        not null default 'sent'
                                         check (delivery_status in ('pending', 'sent', 'responded', 'interrupted', 'failed')),
  elevenlabs_conversation_id text,
  elevenlabs_event_id        bigint,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  check (
    (role = 'user' and client_message_id is not null)
    or
    (role = 'agent' and client_message_id is null)
  )
);

alter table public.carson_typed_messages enable row level security;

drop policy if exists "Users can select their own typed Carson messages"
  on public.carson_typed_messages;

create policy "Users can select their own typed Carson messages"
  on public.carson_typed_messages for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own typed Carson messages"
  on public.carson_typed_messages;

create policy "Users can insert their own typed Carson messages"
  on public.carson_typed_messages for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own typed Carson messages"
  on public.carson_typed_messages;

create policy "Users can update their own typed Carson messages"
  on public.carson_typed_messages for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own typed Carson messages"
  on public.carson_typed_messages;

create policy "Users can delete their own typed Carson messages"
  on public.carson_typed_messages for delete
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete
on public.carson_typed_messages
to authenticated;

-- One browser submission id can be stored only once for an owner. This is the
-- durable half of double-submit protection. The UI also locks while sending.
create unique index if not exists carson_typed_messages_user_client_message
  on public.carson_typed_messages (user_id, client_message_id)
  where client_message_id is not null;

create index if not exists carson_typed_messages_user_created
  on public.carson_typed_messages (user_id, created_at desc);

create index if not exists carson_typed_messages_user_session_created
  on public.carson_typed_messages (user_id, session_id, created_at asc);

create or replace function public.set_carson_typed_messages_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_carson_typed_messages_updated_at
  on public.carson_typed_messages;

create trigger set_carson_typed_messages_updated_at
before update on public.carson_typed_messages
for each row
execute function public.set_carson_typed_messages_updated_at();

-- Saving Carson's reply and marking its owner turn responded belong to the
-- same database transaction. This prevents a successful reply from appearing
-- interrupted after refresh if the browser closes between two client writes.
create or replace function public.mark_typed_carson_turn_responded()
returns trigger language plpgsql as $$
begin
  if new.role = 'agent' and new.reply_to_client_message_id is not null then
    update public.carson_typed_messages
      set delivery_status = 'responded'
      where user_id = new.user_id
        and role = 'user'
        and client_message_id = new.reply_to_client_message_id
        and delivery_status in ('pending', 'sent');
  end if;
  return new;
end;
$$;

drop trigger if exists mark_typed_carson_turn_responded
  on public.carson_typed_messages;

create trigger mark_typed_carson_turn_responded
after insert on public.carson_typed_messages
for each row
execute function public.mark_typed_carson_turn_responded();
