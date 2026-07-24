import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(root, '..', 'supabase', 'migrations', '20260724_staff_message_response_delivery.sql'), 'utf8');
const rollback = readFileSync(join(root, '..', 'supabase', 'migrations', '20260724_staff_message_response_delivery.rollback.sql'), 'utf8');

describe('staff response delivery migration', () => {
  it('uses a durable token-guarded lease and truthful terminal transitions', () => {
    expect(migration).toContain('response_delivery_attempts integer NOT NULL DEFAULT 0');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("response_delivery_lease_until > now()");
    expect(migration).toContain('response_delivery_token=p_claim_token');
    expect(migration).toContain("response_delivery_status='delivered'");
    expect(migration).toContain("response_delivery_status='failed'");
    expect(migration).toContain("response_delivery_status='sending'");
    expect(migration).toContain("response_delivery_error=NULL");
    expect(migration).toContain("response_delivery_lease_until=NULL");
    expect(migration).toContain("CASE WHEN source='whatsapp' THEN 'pending' ELSE 'not_required' END");
  });

  it('rollback restores the prior completion function before dropping delivery state', () => {
    expect(rollback.indexOf('CREATE OR REPLACE FUNCTION public.complete_staff_message')).toBeGreaterThan(0);
    expect(rollback.indexOf('DROP COLUMN IF EXISTS response_delivery_status')).toBeGreaterThan(rollback.indexOf('CREATE OR REPLACE FUNCTION public.complete_staff_message'));
  });
});
