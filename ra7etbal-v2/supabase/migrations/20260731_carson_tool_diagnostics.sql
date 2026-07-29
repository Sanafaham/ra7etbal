-- Carson tool-invocation diagnostics.
--
-- Confirmed production incidents (2026-07-29): a direct-message request
-- ("Ask Christopher to reply...") repeatedly produced zero messages/
-- whatsapp_deliveries rows and zero transport logs, with no way to
-- distinguish "the model never called the tool" from "the client never
-- received the call" from "the policy gate rejected it" from "the handler
-- ran and exited early" from "the backend call failed" — every prior
-- investigation on this incident hit the same wall: no persisted record of
-- what actually happened during the turn. This table closes that gap going
-- forward. It cannot retroactively explain incidents that predate it.
--
-- Deliberately owner-scoped direct-INSERT (not service_role-only like
-- reminder_delivery_events): these events originate from the owner's own
-- authenticated browser session during their own Carson conversation, not
-- from an external webhook/push provider whose truthfulness must be
-- protected from client spoofing — the same trust tier already given to
-- carson_memory (the session recap), which is also a client-authored,
-- self-reported record of what happened in that session. This also avoids
-- needing a new serverless route: api/*.js is already at the Hobby
-- 12-function cap (see CLAUDE.md), and this data must originate from the
-- browser in real time, not a scheduled/webhook job.
--
-- No raw message or instruction content is stored. `reason` is a short,
-- deterministic string (a policy rejection reason, a missing-entities list,
-- or a failure-stage name) — never free-text user content. `utterance_hash`
-- and `message_hash` are SHA-256 hex digests, not the text itself.
-- `recipient_person_id` is a safe foreign-key identifier, not a name or
-- phone number.

create table if not exists public.carson_tool_diagnostics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  channel text not null check (channel in ('voice', 'text')),
  tool_name text not null,
  stage text not null check (stage in (
    'invoked',
    'policy_rejected',
    'typed_blocked',
    'handler_started',
    'handler_success',
    'handler_failure',
    'claim_overridden'
  )),
  reason text,
  missing_entities jsonb not null default '[]'::jsonb,
  recipient_person_id uuid references public.people(id) on delete set null,
  utterance_hash text,
  message_hash text,
  created_at timestamptz not null default now()
);

create index if not exists carson_tool_diagnostics_user_id_created_at_idx
  on public.carson_tool_diagnostics(user_id, created_at);

create index if not exists carson_tool_diagnostics_session_id_idx
  on public.carson_tool_diagnostics(session_id);

alter table public.carson_tool_diagnostics enable row level security;

drop policy if exists "Owners can read their own tool diagnostics" on public.carson_tool_diagnostics;
create policy "Owners can read their own tool diagnostics"
  on public.carson_tool_diagnostics for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Owners can record their own tool diagnostics" on public.carson_tool_diagnostics;
create policy "Owners can record their own tool diagnostics"
  on public.carson_tool_diagnostics for insert
  to authenticated
  with check (auth.uid() = user_id);

revoke update, delete on public.carson_tool_diagnostics from anon, authenticated;
grant select, insert on public.carson_tool_diagnostics to authenticated;
grant select, insert, update, delete on public.carson_tool_diagnostics to service_role;
