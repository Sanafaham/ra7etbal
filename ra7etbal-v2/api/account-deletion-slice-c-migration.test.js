import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../supabase/migrations/20261003_account_deletion_slice_c.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../supabase/migrations/20261003_account_deletion_slice_c.rollback.sql', import.meta.url), 'utf8');

describe('Slice C migration contract', () => {
  it('extends the existing request lifecycle instead of creating another request table', () => {
    expect(sql).toContain('ALTER TABLE public.account_deletion_requests');
    expect(sql).not.toMatch(/CREATE TABLE public\.account_deletion_requests/);
    expect(sql).toContain("relational_deletion_status text NOT NULL DEFAULT 'not_started'");
  });

  it('keeps orchestration service-only and never accepts a victim user id', () => {
    expect(sql).not.toMatch(/execute_account_deletion_relational\s*\([^)]*user_id/i);
    for (const signature of [
      'claim_account_deletion_relational(integer)',
      'execute_account_deletion_relational(uuid, uuid)',
      'fail_account_deletion_relational(uuid, uuid, text, boolean)',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role`);
    }
  });

  it('preserves later-stage correlation without copying personal content', () => {
    expect(sql).toContain('account_deletion_cleanup_references');
    expect(sql).toContain("'storage_object'");
    expect(sql).toContain("'elevenlabs_conversation'");
    expect(sql).not.toMatch(/account_deletion_cleanup_references[\s\S]{0,500}\b(content|body|note|instruction|transcript)\b/i);
  });

  it('deletes every current Carson persistence store and blocks stale recreation', () => {
    for (const table of [
      'carson_facts', 'carson_memory', 'carson_notes', 'carson_pending_operations',
      'carson_persistent_memory', 'carson_todos', 'carson_tool_diagnostics', 'carson_typed_messages',
    ]) {
      expect(sql).toContain(`DELETE FROM public.${table} WHERE user_id = v_user_id`);
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain('reject_frozen_account_owned_data_insert');
  });

  it('does not delete protected later or ambiguous domains', () => {
    for (const table of ['profiles', 'people', 'whatsapp_consent_log', 'whatsapp_inbound_evidence']) {
      expect(sql).not.toContain(`DELETE FROM public.${table}`);
    }
    expect(sql).not.toContain('DELETE FROM auth.users');
    expect(sql).not.toMatch(/storage\.objects[\s\S]*DELETE|DELETE[\s\S]*storage\.objects/i);
    expect(sql).toContain("'whatsapp_inbound_evidence', 'blocked'");
  });

  it('is lease-fenced, idempotent, and rollback stays inside Slice C', () => {
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain('relational_deletion_lease_token = p_lease_token');
    expect(rollback).toContain('DROP TABLE IF EXISTS public.account_deletion_cleanup_references');
    expect(rollback).not.toContain('DROP TABLE IF EXISTS public.account_deletion_requests');
    expect(rollback).not.toContain('DROP TABLE IF EXISTS public.account_deletion_work_cancellations');
  });
});
