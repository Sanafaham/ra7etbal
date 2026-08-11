import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDueReminderNotification, getOrCreateOwnerNotification } from './_owner-notifications.js';

afterEach(() => vi.unstubAllGlobals());

describe('owner notification canonical claim', () => {
  it('returns the inserted canonical row on first creation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ id: 'notification-1' }], 201)));
    const result = await getOrCreateOwnerNotification(input());
    expect(result).toEqual({ created: true, notification: { id: 'notification-1' } });
  });

  it('loads the existing row only for the exact unique-constraint duplicate', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: '23505',
        message: 'duplicate key value violates unique constraint "owner_notifications_user_event_key_key"',
      }, 409))
      .mockResolvedValueOnce(jsonResponse([{ id: 'notification-1' }]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await getOrCreateOwnerNotification(input());
    expect(result).toEqual({ created: false, notification: { id: 'notification-1' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not disguise unrelated database errors as a duplicate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ code: '42501', message: 'denied' }, 403)));
    await expect(getOrCreateOwnerNotification(input())).rejects.toThrow('denied');
  });

  it('uses semantic reminder identity, never a device identity', () => {
    expect(buildDueReminderNotification({
      id: 'task-1', user_id: 'user-1', description: 'Check the bill',
      due_at: '2026-08-12T10:00:00.000Z',
    })).toEqual(expect.objectContaining({
      eventKey: 'reminder_due:task-1',
      userId: 'user-1',
      targetUrl: '/updates?tab=todo',
    }));
  });
});

function input() {
  return {
    supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'service-key',
    userId: 'user-1', eventKey: 'reminder_due:task-1', kind: 'reminder_due',
    title: 'Ra7etBal', body: 'Check the bill', occurredAt: '2026-08-12T10:00:00.000Z',
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}
