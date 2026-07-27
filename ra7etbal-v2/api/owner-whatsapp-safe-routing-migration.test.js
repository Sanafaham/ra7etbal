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

describe('owner WhatsApp safe routing Slice 1 migration', () => {
  it('adds only the deferred general-command outcome needed by this slice', () => {
    expect(forward).toContain("'general_command_deferred'");
    expect(forward).toContain("'resolved_escalation'");
    expect(forward).toContain("'clarification_sent'");
  });

  it('validates and persists app versus WhatsApp reply channels', () => {
    expect(forward).toContain("p_owner_reply_channel text DEFAULT 'app'");
    expect(forward).toContain("v_channel NOT IN ('app', 'whatsapp')");
    expect(forward).toContain('owner_reply_channel = v_channel');
    expect(forward).toContain("owner_reply_channel IN ('app', 'whatsapp')");
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
    expect(rollback).not.toContain("'general_command_deferred'");
  });
});
