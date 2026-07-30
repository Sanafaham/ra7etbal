-- Protected Carson communication-routing observability.
--
-- Additive only: preserves existing rows and policies. Raw owner utterances
-- and outbound message content remain excluded; those continue to be stored
-- only as SHA-256 hashes by carson-tool-diagnostics.ts.

alter table public.carson_tool_diagnostics
  drop constraint if exists carson_tool_diagnostics_stage_check;

alter table public.carson_tool_diagnostics
  add constraint carson_tool_diagnostics_stage_check
  check (stage in (
    'invoked',
    'policy_rejected',
    'typed_blocked',
    'handler_started',
    'handler_success',
    'handler_failure',
    'claim_overridden',
    'people_action_mapped',
    'people_action_clarify',
    'legacy_people_tool_bypass',
    'legacy_people_tool_redirected',
    'duplicate_suppressed'
  ));

alter table public.carson_tool_diagnostics
  add column if not exists delivery_id text,
  add column if not exists transport_message_id text;
