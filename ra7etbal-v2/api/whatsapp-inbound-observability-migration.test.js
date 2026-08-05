import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(
  here, '..', 'supabase', 'migrations', '20260806_owner_inbound_observability.sql',
), 'utf8');
const rollback = readFileSync(join(
  here, '..', 'supabase', 'migrations', '20260806_owner_inbound_observability.rollback.sql',
), 'utf8');

describe('WhatsApp inbound observability migration', () => {
  it('stores minimal raw and normalized correlation evidence', () => {
    for (const field of [
      'inbound_meta_message_id', 'context_present', 'raw_context_id',
      'raw_context_from', 'normalized_context_message_id', 'message_type',
      'sender_phone', 'business_number_id', 'webhook_received_at',
    ]) expect(sql).toContain(field);
    expect(sql).not.toMatch(/message_body|webhook_payload|raw_payload/i);
  });

  it('is idempotent, immutable, private, and service-role only', () => {
    expect(sql).toContain('ON CONFLICT (business_number_id, inbound_meta_message_id) DO NOTHING');
    expect(sql).toContain("RAISE EXCEPTION 'inbound_evidence_conflict'");
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL ON public.whatsapp_inbound_evidence FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
  });

  it('has an ordered rollback for only the new objects', () => {
    const functionDrop = rollback.indexOf('DROP FUNCTION IF EXISTS public.record_whatsapp_inbound_evidence');
    const triggerDrop = rollback.indexOf('DROP TRIGGER IF EXISTS reject_whatsapp_inbound_evidence_update');
    const tableDrop = rollback.indexOf('DROP TABLE IF EXISTS public.whatsapp_inbound_evidence');
    expect(functionDrop).toBeGreaterThanOrEqual(0);
    expect(triggerDrop).toBeGreaterThan(functionDrop);
    expect(tableDrop).toBeGreaterThan(triggerDrop);
  });
});
