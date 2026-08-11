import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const migrations = join(directory, '..', 'supabase', 'migrations');
const migration = readFileSync(
  join(migrations, '20260811_owner_reminder_whatsapp_delivery.sql'),
  'utf8',
);
const verification = readFileSync(
  join(migrations, 'verification', 'owner_reminder_whatsapp_claim_verification.sql'),
  'utf8',
);

describe('owner reminder WhatsApp durable-claim migration', () => {
  it('uses the narrow partial unique index and never a broad task constraint', () => {
    expect(migration).toContain('whatsapp_deliveries_owner_reminder_task_uidx');
    expect(migration).toContain('ON public.whatsapp_deliveries (task_id)');
    expect(migration).toContain("WHERE source_type = 'owner_reminder' AND task_id IS NOT NULL");
    expect(migration).not.toMatch(/UNIQUE\s*\(task_id\)/i);
  });

  it('real-Postgres verification covers duplicate, other-source, and other-task cases', () => {
    expect(verification).toContain("v_constraint_name <> 'whatsapp_deliveries_owner_reminder_task_uidx'");
    expect(verification).toContain("VALUES (v_user, v_task_1, 'delegation')");
    expect(verification).toContain("VALUES (v_user, v_task_2, 'owner_reminder')");
    expect(verification).toContain('EXCEPTION WHEN unique_violation');
  });
});
