import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../supabase/migrations/20261003_account_deletion_slice_a.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../supabase/migrations/20261003_account_deletion_slice_a.rollback.sql', import.meta.url), 'utf8');

describe('account deletion Slice A migration', () => {
  it('stores one active owner-scoped process with no personal content fields', () => {
    expect(sql).toContain('CREATE TABLE public.account_deletion_requests');
    expect(sql).toContain('account_deletion_requests_one_active_per_user');
    expect(sql).toContain("WHERE status <> 'completed'");
    expect(sql).not.toMatch(/message_content|conversation|phone|email|attachment/i);
    expect(sql).toContain('user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL');
  });

  it('records minimal append-only transition evidence without retaining an auth identity', () => {
    expect(sql).toContain('CREATE TABLE public.account_deletion_events');
    expect(sql).toContain('CREATE TRIGGER record_account_deletion_transition');
    expect(sql).toContain('NEW.status IS DISTINCT FROM OLD.status');
    expect(sql).toContain("CHECK (status = 'completed' OR user_id IS NOT NULL)");
  });

  it('requires a recent matching Supabase session and derives auth.uid server-side', () => {
    expect(sql).toContain('v_user_id uuid := auth.uid()');
    expect(sql).toContain("auth.jwt() ->> 'session_id'");
    expect(sql).toContain('FROM auth.sessions s');
    expect(sql).toContain("s.created_at >= now() - interval '15 minutes'");
    expect(sql).not.toMatch(/request_account_deletion\s*\(\s*p_user_id/i);
  });

  it('blocks direct consequential inserts for frozen accounts', () => {
    for (const table of ['tasks', 'messages', 'automations', 'routines']) {
      expect(sql).toContain(`BEFORE INSERT ON public.${table}`);
    }
    expect(sql).toContain("RAISE EXCEPTION 'account_deletion_in_progress'");
  });

  it('exposes only owner read plus the authenticated request RPC', () => {
    expect(sql).toContain('USING (auth.uid() = user_id)');
    expect(sql).toContain('REVOKE ALL ON public.account_deletion_requests FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('GRANT SELECT ON public.account_deletion_requests TO authenticated');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.request_account_deletion() TO authenticated');
  });

  it('has an ordered rollback for every Slice A object', () => {
    expect(rollback).toContain('DROP TRIGGER IF EXISTS reject_frozen_account_task_insert');
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.request_account_deletion()');
    expect(rollback).toContain('DROP TABLE IF EXISTS public.account_deletion_events');
    expect(rollback.trim().endsWith('DROP TABLE IF EXISTS public.account_deletion_requests;')).toBe(true);
  });
});
