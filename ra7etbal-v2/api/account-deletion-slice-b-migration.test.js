import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/20261003_account_deletion_slice_b.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../supabase/migrations/20261003_account_deletion_slice_b.rollback.sql', import.meta.url), 'utf8');

describe('account deletion Slice B migration', () => {
  it('creates minimal tenant-readable cancellation evidence without payload content', () => {
    expect(sql).toContain('CREATE TABLE public.account_deletion_work_cancellations');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('r.user_id = auth.uid()');
    expect(sql).not.toMatch(/message_content|transcript|payload\s+json/i);
  });

  it('inventories each durable local continuation and invalidates pending operations', () => {
    for (const kind of ['qstash_reminder', 'pending_task', 'automation', 'automation_run', 'pending_operation']) {
      expect(sql).toContain(`'${kind}'`);
    }
    expect(sql).toContain("SET status = 'cancelled'");
    expect(sql).toContain('AFTER INSERT OR UPDATE OF freeze_started_at ON public.account_deletion_requests');
    expect(sql).toContain('SET freeze_started_at = freeze_started_at');
  });

  it('uses a service-only SKIP LOCKED lease and fenced completion', () => {
    expect(sql).toContain('FOR UPDATE OF c SKIP LOCKED');
    expect(sql).toContain("'external_cancellation_attempted',");
    expect(sql).toContain('AND lease_token = p_lease_token');
    expect(sql).toContain('TO service_role');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
  });

  it('keeps confirmed, retryable, terminal and unknown outcomes distinct', () => {
    for (const state of ['external_cancellation_confirmed', 'external_outcome_unknown', 'failed_retryable', 'failed_requires_review']) {
      expect(sql).toContain(`'${state}'`);
    }
  });

  it('has an explicit rollback for only Slice B objects', () => {
    expect(rollback).toContain('DROP TABLE IF EXISTS public.account_deletion_work_cancellations');
    expect(rollback).not.toContain('DROP TABLE IF EXISTS public.account_deletion_requests');
  });
});
