import { describe, expect, it } from 'vitest';
import { signReminderReceipt, verifyReminderReceipt } from './_reminder-delivery.js';

const fields = {
  taskId: 'task-1',
  userId: 'user-1',
  subscriptionId: 'sub-1',
  dueAt: '2026-07-28T03:05:00.000Z',
};

describe('reminder delivery receipt capabilities', () => {
  it('accepts the exact task-scoped signed receipt', () => {
    const token = signReminderReceipt(fields, 'secret');
    expect(verifyReminderReceipt(fields, token, 'secret')).toBe(true);
  });

  it('rejects a receipt replayed for another subscription or due time', () => {
    const token = signReminderReceipt(fields, 'secret');
    expect(verifyReminderReceipt({ ...fields, subscriptionId: 'sub-2' }, token, 'secret')).toBe(false);
    expect(verifyReminderReceipt({ ...fields, dueAt: '2026-07-28T03:06:00.000Z' }, token, 'secret')).toBe(false);
  });
});
