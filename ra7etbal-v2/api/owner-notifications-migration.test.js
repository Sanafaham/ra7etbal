import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const migration = readFileSync(join(root, '20260811231000_owner_notifications.sql'), 'utf8');
const verification = readFileSync(join(root, 'verification', 'owner_notifications_verification.sql'), 'utf8');
const concurrency = readFileSync(join(root, 'verification', 'owner_notifications_concurrency_verification.sql'), 'utf8');

describe('owner notifications additive migration', () => {
  it('enforces canonical identity, newest-first access, and unread access', () => {
    expect(migration).toContain('owner_notifications_user_event_key_key UNIQUE (user_id, event_key)');
    expect(migration).toContain('(user_id, occurred_at DESC)');
    expect(migration).toContain('WHERE read_at IS NULL');
  });

  it('allows only owner-scoped reads/read-state updates for authenticated clients', () => {
    expect(migration).toContain('USING (auth.uid() = user_id)');
    expect(migration).toContain('WITH CHECK (auth.uid() = user_id)');
    expect(migration).toContain('GRANT SELECT, UPDATE (read_at)');
    expect(migration).not.toMatch(/GRANT\s+INSERT[^;]*authenticated/i);
    expect(migration).not.toMatch(/GRANT\s+DELETE[^;]*authenticated/i);
  });

  it('verifies duplicate rejection and allows the same semantic key for another owner', () => {
    expect(verification).toContain('EXCEPTION WHEN unique_violation');
    expect(verification).toContain('owner_notifications_user_event_key_key');
    expect(verification).toContain("'20000000-0000-4000-8000-000000000002', 'reminder_due:one'");
  });

  it('uses two genuine database sessions to prove concurrent creation leaves one row', () => {
    expect(concurrency).toContain("dblink_connect('notification_concurrent_b'");
    expect(concurrency).toContain("dblink_is_busy('notification_concurrent_b')");
    expect(concurrency).toContain('owner_notifications_user_event_key_key');
    expect(concurrency).toContain("event_key = 'reminder_due:concurrent') <> 1");
  });

  it('verifies owner isolation, unread count, mark one, mark all, and write denial', () => {
    expect(verification).toContain('Owner A must see exactly its own two rows');
    expect(verification).toContain('mark one read must affect exactly one owned row');
    expect(verification).toContain('Owner A mark-all changed Owner B');
    expect(verification).toContain('authenticated insert unexpectedly succeeded');
    expect(verification).toContain('authenticated delete unexpectedly succeeded');
  });
});
