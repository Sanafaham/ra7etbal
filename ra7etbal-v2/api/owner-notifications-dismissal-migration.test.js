import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const migration = readFileSync(join(root, '20260814180000_owner_notifications_soft_dismiss.sql'), 'utf8');
const baseMigration = readFileSync(join(root, '20260811231000_owner_notifications.sql'), 'utf8');

describe('owner notification soft dismissal', () => {
  it('is additive, preserves history and grants only the dismissal column', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS dismissed_at');
    expect(migration).toContain('WHERE dismissed_at IS NULL');
    expect(migration).toContain('GRANT UPDATE (dismissed_at)');
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    expect(migration).not.toMatch(/DROP\s+/i);
    expect(migration).not.toMatch(/GRANT\s+DELETE/i);
  });

  it('inherits owner-scoped RLS so cross-user dismissal is impossible', () => {
    expect(baseMigration).toContain('ON public.owner_notifications FOR UPDATE TO authenticated');
    expect(baseMigration).toContain('USING (auth.uid() = user_id)');
    expect(baseMigration).toContain('WITH CHECK (auth.uid() = user_id)');
    expect(migration).not.toMatch(/CREATE\s+POLICY|ALTER\s+POLICY|DROP\s+POLICY/i);
    expect(migration).not.toMatch(/GRANT\s+UPDATE\s*\([^)]*user_id/i);
  });
});
