-- Commitment Lifecycle Amendments S2 + S3
-- Constitutional basis: COS Ch. 13.5 (Frozen 2026-08-01)
--
-- Amendment S2: A commitment that enters the Indeterminate state shall be
-- immediately registered with Open Loop Governance as an active open loop.
-- Indeterminate is not a resting state.
--
-- Amendment S3: Reopening a commitment that has reached Verified Complete
-- (status = 'done') requires explicit owner authorisation or new verified
-- evidence from Epistemic Governance. The authority for reopening is governed
-- by Authority and Consent Governance (Ch. 8).
--
-- Additive migration — no existing columns are removed or renamed.

-- S2: Guard columns for Indeterminate OLG registration.
-- uncertain_olg_registered_at: stamped when a task enters Indeterminate state
--   and OLG registration is scheduled (QStash +4h follow-up).
-- uncertain_escalated_at: stamped when the OLG follow-up fires and a second
--   owner push is sent. Null until that escalation runs.
alter table public.tasks
  add column if not exists uncertain_olg_registered_at timestamptz,
  add column if not exists uncertain_escalated_at timestamptz;

comment on column public.tasks.uncertain_olg_registered_at is
  'COS Ch. 13.5 S2: Timestamp when this task entered an Indeterminate commitment '
  'state (quality_review_status IN (uncertain, fraud_suspected)) and was registered '
  'with Open Loop Governance. Drives the +4h OLG escalation check.';

comment on column public.tasks.uncertain_escalated_at is
  'COS Ch. 13.5 S2: Timestamp when the OLG follow-up escalation was sent for an '
  'Indeterminate task. Null until the escalation fires. Once stamped, no further '
  'OLG escalation is sent for the current Indeterminate episode.';

-- S3: Prevent unauthorized Verified Complete → Authorized (Reopened) transitions.
-- A BEFORE UPDATE trigger raises an exception if status transitions from done
-- to pending without going through the authorized reopen path.
-- The authorized path (future: reopen_task RPC) will set status = 'pending'
-- with a bypass flag or via a separate RPC that checks authority first.
-- Current enforcement: block ALL done → pending transitions at the DB layer
-- since no legitimate code path currently makes this transition.
create or replace function public.enforce_reopen_authority()
returns trigger
language plpgsql
security definer
as $$
begin
  if old.status = 'done' and new.status = 'pending' then
    raise exception
      'reopen_requires_authorization: transitioning a commitment from Verified '
      'Complete (done) to Authorized (pending) requires explicit owner '
      'authorisation or new verified evidence from Epistemic Governance. '
      'See COS Ch. 13.5 Amendment S3.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_commitment_reopen_authority on public.tasks;

create trigger enforce_commitment_reopen_authority
  before update on public.tasks
  for each row
  execute function public.enforce_reopen_authority();

comment on function public.enforce_reopen_authority() is
  'COS Ch. 13.5 S3: Blocks status transitions from done (Verified Complete) to '
  'pending (Authorized/Reopened) without an explicit authorized reopen path. '
  'See carson-commitment-lifecycle.ts for the application-layer gate.';
