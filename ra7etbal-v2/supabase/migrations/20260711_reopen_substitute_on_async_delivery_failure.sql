/**
 * Phase 8.1 bug fix — asynchronous WhatsApp delivery failure after a
 * substitute-review decision already completed.
 *
 * Root cause (confirmed via live data + Vercel logs on a real production
 * task): complete_rejected_alternative()/complete_custom_instruction() gate
 * on delivery_status='accepted', which only reflects Meta's SYNCHRONOUS
 * request-acceptance, not actual delivery. Meta can — and in the observed
 * case did, error 131049 "ecosystem engagement" — report a genuine failure
 * asynchronously via the existing api/whatsapp-webhook.js callback, arriving
 * after the decision was already completed and the task had already left
 * substitute_review. Nothing previously told the owner the message never
 * reached the worker.
 *
 * This function is called from api/whatsapp-webhook.js's
 * updateWhatsappDeliveryStatus(), gated on the EXISTING compare-and-swap
 * "updated === true" signal for a first-time transition to 'failed' — that
 * gate already makes the caller idempotent (a duplicate Meta callback finds
 * delivery_status already 'failed', buildDeliveryStatusPatch() returns null,
 * updated stays false, this function is never called a second time). No new
 * dedup key needed; reuses existing infrastructure.
 *
 * Scope, by design:
 *   - Only matches a whatsapp_deliveries row that IS linked to a completed
 *     rejected_alternative/custom_instruction decision (delivery_id FK) —
 *     ordinary WhatsApp failures (delegations, corrections, automations,
 *     routine messages) have no such row and are structurally untouched.
 *   - approved_alternative never has a delivery_id at all (Approve sends no
 *     message) — structurally cannot match, cannot be affected.
 *   - Defensively re-checks the task hasn't independently moved on (status
 *     still 'pending', quality_review_status still exactly what completion
 *     set it to) before reopening, so a late webhook can never clobber
 *     newer, unrelated task state.
 *   - The old decision row is left exactly as a true historical record
 *     (status/outcome untouched) — only a note is added explaining why it no
 *     longer reflects the live task state. A fresh review cycle begins via a
 *     new quality_reviewed_at; the next owner action creates its own new
 *     decision row via the existing claim_substitute_decision() path.
 *   - Does not touch quality_review_cycle_count — a rejected-alternative
 *     decision that later failed to deliver still counted as one correction
 *     attempt; not rolling it back avoids a new race surface and keeps the
 *     3-attempt ceiling meaningful even across delayed async failures.
 */

create or replace function public.reopen_substitute_decision_on_delivery_failure(
  p_delivery_id uuid
) returns table(task_id uuid, user_id uuid, description text, assigned_to text, reopened boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_decision quality_substitute_decisions;
  v_task tasks;
  v_expected_status text;
begin
  select * into v_decision from quality_substitute_decisions
    where delivery_id = p_delivery_id
      and status = 'completed'
      and decision in ('rejected_alternative', 'custom_instruction')
    limit 1
    for update;

  if not found then
    return query select null::uuid, null::uuid, null::text, null::text, false;
    return;
  end if;

  v_expected_status := case when v_decision.decision = 'rejected_alternative' then 'correction_required' else null end;

  select * into v_task from tasks where id = v_decision.task_id for update;

  if not found
     or v_task.status <> 'pending'
     or v_task.quality_review_status is distinct from v_expected_status then
    -- Task moved on for an unrelated reason since this decision completed —
    -- never clobber newer state with a stale reopen.
    return query select v_decision.task_id, v_decision.user_id, null::text, null::text, false;
    return;
  end if;

  update tasks set
    quality_review_status = 'substitute_review',
    quality_review_note = coalesce(v_decision.qi_note, v_task.quality_review_note),
    quality_reviewed_at = now(),
    worker_reply = v_decision.worker_reply
  where id = v_decision.task_id;

  update quality_substitute_decisions
  set failure_reason = 'WhatsApp delivery failed asynchronously after this decision completed — task reopened for a new owner decision.'
  where id = v_decision.id;

  return query select v_decision.task_id, v_decision.user_id, v_task.description, v_task.assigned_to, true;
end;
$$;

revoke execute on function public.reopen_substitute_decision_on_delivery_failure(uuid) from public, anon, authenticated;
grant execute on function public.reopen_substitute_decision_on_delivery_failure(uuid) to service_role;
