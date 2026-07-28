import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const forward = readFileSync(
  new URL('../supabase/migrations/20260728_owner_whatsapp_safe_routing_slice_1.sql', import.meta.url),
  'utf8',
);
const rollback = readFileSync(
  new URL('../supabase/migrations/20260728_owner_whatsapp_safe_routing_slice_1.rollback.sql', import.meta.url),
  'utf8',
);
const deployment = readFileSync(
  new URL('../docs/OWNER_WHATSAPP_SAFE_ROUTING_DEPLOYMENT.md', import.meta.url),
  'utf8',
);

describe('owner WhatsApp safe routing Slice 1 migration', () => {
  it('adds durable executed and unsupported general-command outcomes', () => {
    expect(forward).toContain("'general_command_executed'");
    expect(forward).toContain("'unsupported_command'");
    expect(forward).toContain("'terminal_failure'");
    expect(forward).not.toContain("'general_command_deferred'");
    expect(forward).toContain("'resolved_escalation'");
    expect(forward).toContain("'clarification_sent'");
  });

  it('validates and persists app versus WhatsApp reply channels', () => {
    const addColumn = forward.indexOf('ADD COLUMN IF NOT EXISTS owner_reply_channel text');
    const channelConstraint = forward.indexOf('staff_escalation_owner_decisions_owner_reply_channel_check');
    expect(addColumn).toBeGreaterThan(-1);
    expect(channelConstraint).toBeGreaterThan(addColumn);
    expect(forward).toContain("p_owner_reply_channel text DEFAULT 'app'");
    expect(forward).toContain("v_channel NOT IN ('app', 'whatsapp')");
    expect(forward).toContain('owner_reply_channel = v_channel');
    expect(forward).toContain("owner_reply_channel IN ('app', 'whatsapp')");
  });

  it('supports terminal retry exhaustion and keeps two-argument callers compatible', () => {
    expect(forward).toContain("'terminal_failed'");
    expect(forward).toContain("p_owner_reply_channel text DEFAULT 'app'");
  });

  it('keeps answer mutation service-role-only', () => {
    expect(forward).toContain(
      'REVOKE EXECUTE ON FUNCTION public.answer_escalation_owner_decision(uuid, text, text)',
    );
    expect(forward).toContain(
      'GRANT EXECUTE ON FUNCTION public.answer_escalation_owner_decision(uuid, text, text)',
    );
    expect(forward).toContain('TO service_role');
  });

  it('provides a rollback for both forward changes', () => {
    expect(rollback).toContain(
      'DROP FUNCTION IF EXISTS public.answer_escalation_owner_decision(uuid, text, text)',
    );
    expect(rollback).toContain("owner_reply_channel IN ('app')");
    expect(rollback).toContain('rollback_blocked: whatsapp owner reply audit rows exist');
    expect(rollback).toContain('rollback_blocked: owner command audit rows exist');
    expect(rollback.indexOf('rollback_blocked: whatsapp owner reply audit rows exist'))
      .toBeLessThan(rollback.indexOf('DROP FUNCTION IF EXISTS'));
  });

  it('documents safe migration-history reconciliation and deployment order', () => {
    expect(deployment).toContain('Reconcile migration history');
    expect(deployment).toContain('20260727_owner_whatsapp_reply_receipts.sql');
    expect(deployment).toContain('supabase migration repair');
    expect(deployment).toContain('Deploy the code');
    expect(deployment).toContain('feature flag must remain disabled');
    expect(deployment).toContain('Activate one account only');
  });
});
