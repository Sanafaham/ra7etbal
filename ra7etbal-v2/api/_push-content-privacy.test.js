import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_PUSH_BODY,
  GENERIC_PUSH_TITLE,
  buildPrivacySafePushPayload,
} from './_push-content-privacy.js';

const PRIVATE_SENTINELS = [
  'PRIVATE_PERSON_GRACE',
  'PRIVATE_TASK_MEDICINE',
  'PRIVATE_HOUSEHOLD_GUEST_ROOM',
  'PRIVATE_DELEGATION_BUY_FLOWERS',
  'PRIVATE_MESSAGE_CALL_ME_NOW',
  'PRIVATE_CALENDAR_DENTIST_AT_11',
];

describe('external push content privacy', () => {
  it('replaces every private display field and drops unrelated payload data', () => {
    const payload = buildPrivacySafePushPayload({
      title: PRIVATE_SENTINELS[0],
      body: PRIVATE_SENTINELS.slice(1).join(' | '),
      privateMetadata: PRIVATE_SENTINELS.join(' | '),
      notificationId: 'notification-opaque-1',
      url: '/updates?tab=needs-you&task=task-opaque-1',
    });

    expect(payload).toEqual({
      title: GENERIC_PUSH_TITLE,
      body: GENERIC_PUSH_BODY,
      notificationId: 'notification-opaque-1',
      url: '/updates?tab=needs-you&task=task-opaque-1',
    });
    const externalPayload = JSON.stringify(payload);
    for (const sentinel of PRIVATE_SENTINELS) expect(externalPayload).not.toContain(sentinel);
  });

  it('preserves only the opaque receipt fields required by delivery evidence', () => {
    const receipt = {
      url: '/api/qstash-reminder',
      kind: 'completion',
      taskId: 'task-opaque-1',
      subscriptionId: 'subscription-opaque-1',
      dueAt: '2026-10-04T12:00:00.000Z',
      token: 'signed-opaque-token',
    };
    expect(buildPrivacySafePushPayload({ receipt })).toEqual({
      title: GENERIC_PUSH_TITLE,
      body: GENERIC_PUSH_BODY,
      receipt,
    });
  });

  it('is wired into every reachable production web-push producer', async () => {
    const files = [
      'send-push-for-task.js',
      'send-due-reminder-pushes.js',
      'task-confirm.js',
      'process-delegation-escalations.js',
    ];
    for (const file of files) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(source, file).toContain("from './_push-content-privacy.js'");
      expect(source, file).toContain('buildPrivacySafePushPayload(');
    }
  });
});
