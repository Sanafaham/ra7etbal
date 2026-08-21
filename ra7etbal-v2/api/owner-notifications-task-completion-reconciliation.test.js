import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const migration = readFileSync(
  join(root, '20260821_owner_notifications_task_completion_reconciliation.sql'),
  'utf8',
);
const rollback = readFileSync(
  join(root, '20260821_owner_notifications_task_completion_reconciliation.rollback.sql'),
  'utf8',
);

describe('owner notification task-completion reconciliation trigger', () => {
  it('fires only on a transition into done, scoped to the row being updated', () => {
    expect(migration).toContain("AFTER UPDATE ON public.tasks");
    expect(migration).toMatch(/NEW\.status\s*=\s*'done'/);
    expect(migration).toMatch(/OLD\.status\s+IS\s+DISTINCT\s+FROM\s+'done'/);
  });

  it('dismisses only a positive allowlist of actionable notification kinds', () => {
    expect(migration).toMatch(/kind\s*=\s*ANY\s*\(\s*ARRAY\s*\[/i);
    expect(migration).toContain("'task_escalation'");
    expect(migration).toContain("'reminder_due'");
    expect(migration).toContain("'routine_reminder'");
    expect(migration).toContain("'task_review_followup'");
    expect(migration).toContain("'automation_reminder'");
  });

  it('is tenant-isolated and idempotent, and never invents a timestamp', () => {
    expect(migration).toContain('target_type');
    expect(migration).toMatch(/user_id\s*=\s*NEW\.user_id/);
    expect(migration).toContain('dismissed_at IS NULL');
    expect(migration).toMatch(/dismissed_at\s*=\s*COALESCE\(NEW\.confirmed_at,\s*now\(\)\)/);
  });

  it('never deletes rows, backfills history, or widens grants', () => {
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    expect(migration).not.toMatch(/GRANT\s+/i);
    expect(migration).not.toMatch(/DROP\s+POLICY/i);
  });

  it('has a matching rollback that removes the trigger and function cleanly', () => {
    expect(rollback).toContain('DROP TRIGGER IF EXISTS reconcile_owner_notifications_on_task_done ON public.tasks');
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.reconcile_owner_notifications_on_task_done()');
  });
});
