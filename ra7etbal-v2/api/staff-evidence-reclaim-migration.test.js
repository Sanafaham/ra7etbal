import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, '..', 'supabase', 'migrations', '20260804_reclaim_staff_evidence_message.sql'),
  'utf8',
);

describe('staff evidence reclaim migration — additive ownership primitive', () => {
  it('adds one new RPC without schema, data, RLS, or existing-RPC changes', () => {
    expect(SQL).toContain('CREATE FUNCTION public.reclaim_staff_evidence_message(');
    expect(SQL).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(SQL).not.toMatch(/CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+POLICY|ALTER\s+POLICY/i);
    expect(SQL).not.toMatch(/UPDATE\s+public\.(?:tasks|confirmations|messages|whatsapp_deliveries)/i);
    expect(SQL).not.toMatch(/INSERT\s+INTO|DELETE\s+FROM/i);
    expect(SQL).not.toContain('claim_staff_message(');
    expect(SQL).not.toContain('retry_staff_message(');
    expect(SQL).not.toContain('complete_staff_message(');
    expect(SQL).not.toContain('fail_staff_message(');
  });

  it('serializes ownership and fences the exact observed processing generation', () => {
    expect(SQL).toContain('FOR UPDATE;');
    expect(SQL).toContain('v_current.updated_at IS DISTINCT FROM p_expected_updated_at');
    expect(SQL).toContain("v_current.updated_at > now() - interval '120 seconds'");
    expect(SQL).toContain('sm.updated_at = p_expected_updated_at');
    expect(SQL).toContain("sm.processing_status IN ('claimed', 'failed')");
    expect(SQL).toContain('SELECT v_row.id, true, v_row.processing_status');
  });

  it('is restricted to durable WhatsApp photo evidence and service_role', () => {
    expect(SQL).toContain("v_current.source <> 'whatsapp'");
    expect(SQL).toContain("v_current.inbound_text NOT LIKE '[Photo evidence]%'");
    expect(SQL).toContain('v_current.external_message_id IS NULL');
    expect(SQL).toMatch(/FROM PUBLIC, anon, authenticated;/);
    expect(SQL).toMatch(/TO service_role;/);
  });

  it('contains ownership state only and no task or notification business decisions', () => {
    const updateBlock = SQL.slice(SQL.indexOf('UPDATE public.staff_messages'), SQL.indexOf('RETURNING sm.*'));
    expect(updateBlock).toContain("processing_status = 'claimed'");
    expect(updateBlock).toContain('processing_error = NULL');
    expect(updateBlock).not.toMatch(/task|quality|substitut|correct|notif|owner_attention|user_facing/i);
  });
});
