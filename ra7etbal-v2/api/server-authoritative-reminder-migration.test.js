import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  new URL('../supabase/migrations/20260812190000_server_authoritative_reminder_inserts.sql', import.meta.url),
  'utf8',
);
const EXECUTABLE_SQL = SQL.replace(/--.*$/gm, '');

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

  it('models the stale-client boundary: its direct reminder INSERT fails while ordinary task INSERTs remain eligible', () => {
    const restrictiveCheck = (row) => row.type !== 'reminder';
    const staleVoiceClientDraft = {
      user_id: 'owner-1',
      type: 'reminder',
      description: 'PR236 automation synchronization production verification',
      assigned_to: null,
      due_at: '2026-08-12T04:00:00.000Z',
    };
    expect(restrictiveCheck(staleVoiceClientDraft)).toBe(false);
    expect(restrictiveCheck({ ...staleVoiceClientDraft, type: 'action' })).toBe(true);
    expect(restrictiveCheck({ ...staleVoiceClientDraft, type: 'delegation' })).toBe(true);
  });
});
