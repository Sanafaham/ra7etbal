alter table public.carson_tool_diagnostics
  drop column if exists action_type,
  drop column if exists selected_tool;

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
    'claim_overridden'
  ));
