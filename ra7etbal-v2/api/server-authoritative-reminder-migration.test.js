import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  new URL('../supabase/migrations/20260812190000_server_authoritative_reminder_inserts.sql', import.meta.url),
  'utf8',
);
const EXECUTABLE_SQL = SQL.replace(/--.*$/gm, '');
const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/server-authoritative-reminder-rls-verification.yml', import.meta.url),
  'utf8',
);
const DATABASE_VERIFICATION = readFileSync(
  new URL('../supabase/migrations/verification/server_authoritative_reminder_rls_verification.sql', import.meta.url),
  'utf8',
);

describe('server-authoritative reminder INSERT migration', () => {
  it('adds a narrow restrictive authenticated INSERT policy', () => {
    expect(SQL).toMatch(/alter table public\.tasks enable row level security/i);
    expect(SQL).toMatch(/create policy "tasks: reminders require server creation"[\s\S]*as restrictive[\s\S]*for insert[\s\S]*to authenticated/i);
    expect(SQL).toMatch(/with check \(type <> 'reminder'\)/i);
  });

  it('does not alter rows, drop policies, or block non-reminder task types', () => {
    expect(EXECUTABLE_SQL).not.toMatch(/\b(update|delete from|truncate|drop policy|alter column)\b/i);
    expect(EXECUTABLE_SQL).not.toMatch(/type\s*=\s*'reminder'/i);
  });

  it('has a path-filtered PostgreSQL 16 check that applies the exact migration and executes role-level proof', () => {
    expect(WORKFLOW).toMatch(/image: postgres:16/);
    expect(WORKFLOW).toContain('20260812190000_server_authoritative_reminder_inserts.sql');
    expect(WORKFLOW).toContain('server_authoritative_reminder_rls_verification.sql');

    expect(DATABASE_VERIFICATION).toMatch(/SET ROLE authenticated/);
    expect(DATABASE_VERIFICATION).toMatch(/SET ROLE service_role/);
    expect(DATABASE_VERIFICATION).toMatch(/cross-owner INSERT unexpectedly succeeded/);
    expect(DATABASE_VERIFICATION).toMatch(/pre-existing reminder update changed/);
    expect(DATABASE_VERIFICATION).toMatch(/pg_policies/);
  });
});
