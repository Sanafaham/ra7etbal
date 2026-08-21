import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const migration = readFileSync(
  join(root, '20260822_automation_run_task_completion_reconciliation.sql'),
  'utf8',
);
const rollback = readFileSync(
  join(root, '20260822_automation_run_task_completion_reconciliation.rollback.sql'),
  'utf8',
);
const syncHelper = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '_automation-run-confirmation-sync.js'),
  'utf8',
);

describe('automation run task-completion reconciliation trigger', () => {
  it('fires only on a transition into done with a truthful confirmed_at', () => {
    expect(migration).toContain('AFTER UPDATE ON public.tasks');
    expect(migration).toMatch(/NEW\.status\s*=\s*'done'/);
    expect(migration).toMatch(/OLD\.status\s+IS\s+DISTINCT\s+FROM\s+'done'/);
    expect(migration).toMatch(/NEW\.confirmed_at\s+IS\s+NOT\s+NULL/);
    expect(migration).not.toMatch(/COALESCE\(NEW\.confirmed_at,\s*now\(\)\)/);
  });

  it('uses the exact same source-state allowlist the JS sync helper considers confirmable', () => {
    const confirmableMatch = syncHelper.match(/CONFIRMABLE_RUN_STATES\s*=\s*\[([\s\S]*?)\]/);
    expect(confirmableMatch).not.toBeNull();
    const confirmableStates = confirmableMatch[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1));
    expect(confirmableStates).toEqual(['task_created', 'sent', 'followup_sent', 'escalated', 'failed']);
    for (const state of confirmableStates) {
      expect(migration).toContain(`'${state}'`);
    }
  });

  it('only ever transitions rows already in a confirmable source state, never a protected one', () => {
    const protectedMatch = syncHelper.match(/PROTECTED_RUN_STATES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(protectedMatch).not.toBeNull();
    const protectedStates = protectedMatch[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1));
    expect(protectedStates).toEqual(['skipped', 'confirmed', 'completed']);

    // The UPDATE's own WHERE clause re-checks current_state against the
    // confirmable allowlist, so a row already in a protected state can
    // never match it -- extract that WHERE-clause allowlist specifically
    // (the second ARRAY[...] block, inside the UPDATE) and assert it
    // contains none of the protected states.
    const updateBlock = migration.slice(migration.indexOf('UPDATE public.automation_runs'));
    const whereAllowlist = updateBlock.match(/current_state\s*=\s*ANY\s*\(\s*ARRAY\s*\[([\s\S]*?)\]/);
    expect(whereAllowlist).not.toBeNull();
    for (const state of protectedStates) {
      expect(whereAllowlist[1]).not.toContain(`'${state}'`);
    }
  });

  it('fails closed on ambiguous multiple-run matches instead of updating all of them', () => {
    expect(migration).toMatch(/count\(\*\)/);
    expect(migration).toMatch(/v_eligible_count\s*=\s*1/);
  });

  it('is tenant-isolated on task_id and user_id together', () => {
    expect(migration).toMatch(/task_id\s*=\s*NEW\.id/);
    expect(migration).toMatch(/user_id\s*=\s*NEW\.user_id/);
  });

  it('never deletes rows, backfills history, or widens grants', () => {
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    expect(migration).not.toMatch(/^\s*GRANT\s/m);
    expect(migration).not.toMatch(/DROP\s+POLICY/i);
  });

  it('has a matching rollback that removes the trigger and function cleanly', () => {
    expect(rollback).toContain('DROP TRIGGER IF EXISTS reconcile_automation_run_on_task_done ON public.tasks');
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.reconcile_automation_run_on_task_done()');
  });
});
