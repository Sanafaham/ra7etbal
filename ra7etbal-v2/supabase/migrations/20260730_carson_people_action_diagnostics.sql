-- Carson intent-architecture (2026-07-30): route_people_action is the new
-- semantic entry point for person-directed requests (communication and
-- delegation), replacing raw-text regex re-derivation of intent for this
-- capability. This migration extends the existing carson_tool_diagnostics
-- table (see 20260731_carson_tool_diagnostics.sql) additively:
--
-- - Widens the `stage` check constraint with three new stages:
--   people_action_mapped, people_action_clarify, legacy_people_tool_bypass.
-- - Adds `action_type` and `selected_tool`: short enum-like strings the
--   model/app produce (e.g. "interpersonal_communication",
--   "send_direct_whatsapp_message") — never raw utterance or message
--   content, consistent with every other column on this table.
--
-- legacy_people_tool_bypass is compatibility telemetry for the rollout
-- period, tracking how often the model still calls
-- send_direct_whatsapp_message/send_delegation directly instead of via
-- route_people_action — it is not the desired steady state.

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
    'legacy_people_tool_bypass'
  ));

alter table public.carson_tool_diagnostics
  add column if not exists action_type text,
  add column if not exists selected_tool text;
