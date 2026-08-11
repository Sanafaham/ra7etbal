import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyOwnerCommand,
  parseOwnerReminderDue,
  scheduleReminderPush,
} from './_owner-command-executor.js';
import { signReminderReceipt, verifyReminderReceipt } from './_reminder-delivery.js';
import { dedupeSubscriptionsByEndpoint } from './send-push-for-task.js';

const CONTROLLED_COMMAND =
  'Remind me at 7:03 PM today to check the owner WhatsApp acknowledgement.';
const SANA_TIMEZONE = 'Europe/Istanbul';
const EXPECTED_DUE_AT = '2026-07-28T16:03:00.000Z';
const TASK_ID = '86d12029-662f-4991-85d1-45c188bcda34';

const CRITICAL_FILES = [
  '_owner-command-executor.js',
  '_owner-whatsapp-routing.js',
  'whatsapp-webhook.js',
  'qstash-reminder.js',
  'send-push-for-task.js',
  'send-due-reminder-pushes.js',
  '_owner-reminder-whatsapp.js',
  '_reminder-delivery.js',
  '../public/sw.js',
  '../src/lib/push-notifications.ts',
  '../supabase/migrations/20260727_owner_whatsapp_reply_receipts.sql',
  '../supabase/migrations/20260728_owner_whatsapp_safe_routing_slice_1.sql',
  '../supabase/migrations/20260730_reminder_delivery_observability.sql',
  '../supabase/migrations/20260811_owner_reminder_whatsapp_delivery.sql',
  '../supabase/migrations/verification/owner_reminder_whatsapp_claim_verification.sql',
];

describe('golden owner WhatsApp reminder contract', () => {
  it('locks the controlled command to Sana local time while keeping UTC canonical', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T15:59:40.000Z'));
    try {
      const classified = classifyOwnerCommand(CONTROLLED_COMMAND);
      expect(classified).toEqual({
        type: 'reminder',
        text: 'check the owner WhatsApp acknowledgement',
        timeText: 'at 7:03 PM today',
      });
      expect(parseOwnerReminderDue(classified.timeText, SANA_TIMEZONE)).toBe(EXPECTED_DUE_AT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes one deterministic QStash schedule from the canonical due_at', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'qstash-token');
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    vi.stubEnv('APP_BASE_URL', 'https://www.ra7etbal.com');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ messageId: 'qstash-one' }))
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);
    try {
      await scheduleReminderPush({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        taskId: TASK_ID,
        dueAt: EXPECTED_DUE_AT,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [publishUrl, publishInit] = fetchMock.mock.calls[0];
      expect(String(publishUrl)).toContain('/api/send-push-for-task');
      expect(publishInit.headers).toMatchObject({
        'Upstash-Deduplication-Id': `reminder-${TASK_ID}`,
        'Upstash-Not-Before': String(Date.parse(EXPECTED_DUE_AT) / 1000),
        'Upstash-Forward-Authorization': 'Bearer cron-secret',
      });
      expect(JSON.parse(publishInit.body)).toEqual({ taskId: TASK_ID });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        qstash_message_id: 'qstash-one',
        reminder_delivery_status: 'scheduled',
        reminder_delivery_error: null,
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('deduplicates identical endpoints while allowing distinct active endpoints once', () => {
    expect(dedupeSubscriptionsByEndpoint([
      { id: 'first', endpoint: 'https://push.example/a' },
      { id: 'duplicate', endpoint: 'https://push.example/a' },
      { id: 'second', endpoint: 'https://push.example/b' },
    ])).toEqual([
      { id: 'first', endpoint: 'https://push.example/a' },
      { id: 'second', endpoint: 'https://push.example/b' },
    ]);
  });

  it('binds client receipts to the exact owner, task, subscription, and due instant', () => {
    const fields = {
      taskId: TASK_ID,
      userId: '645ddb96-6e09-4d91-b650-cbc75bac9a5d',
      subscriptionId: 'subscription-one',
      dueAt: EXPECTED_DUE_AT,
    };
    const token = signReminderReceipt(fields, 'receipt-secret');
    expect(verifyReminderReceipt(fields, token, 'receipt-secret')).toBe(true);
    expect(verifyReminderReceipt({ ...fields, userId: 'another-household' }, token, 'receipt-secret'))
      .toBe(false);
    expect(verifyReminderReceipt({ ...fields, taskId: 'another-task' }, token, 'receipt-secret'))
      .toBe(false);
  });

  it('locks truthful delivery, retry, service-worker, privacy, and routing boundaries', async () => {
    const sources = Object.fromEntries(await Promise.all(
      CRITICAL_FILES.map(async (file) => [
        file,
        await readFile(new URL(file, import.meta.url), 'utf8'),
      ]),
    ));
    const callback = sources['send-push-for-task.js'];
    expect(callback).toContain('statusCode === 410 || statusCode === 404');
    expect(callback).toContain('result.statusCode !== 404 && result.statusCode !== 410');
    expect(callback).toContain("reminder_delivery_status: 'delivery_unconfirmed'");
    expect(callback).not.toMatch(/provider_accepted[\s\S]{0,500}status:\s*['"]done['"]/);
    expect(callback).toContain('dedupeSubscriptionsByEndpoint');
    expect(callback).toContain("stage: 'callback_received'");
    expect(callback).toContain("stage: 'provider_send_attempted'");
    expect(callback).toContain("stage: 'provider_accepted'");

    const sw = sources['../public/sw.js'];
    expect(sw).toContain('event.waitUntil(');
    expect(sw).toContain('receipt: receipt');
    expect(sw).toContain('notificationId: payload.notificationId');
    expect(sw).toContain('url: safeInternalRoute(payload.url)');
    expect(sw).toContain('"service_worker_received"');
    expect(sw).toContain('"show_notification_attempted"');
    expect(sw).toContain('"show_notification_resolved"');
    expect(sw).toContain('"notification_clicked"');

    const routing = sources['_owner-whatsapp-routing.js'];
    expect(routing).toContain('OWNER_WHATSAPP_ROUTING_USER_IDS');
    expect(routing).toContain('acknowledgementAlreadyAccepted');
    expect(routing).toContain('terminal_failed');
    expect(routing).not.toMatch(/openRows|openEscalations|open_escalation_count/i);

    const migration = sources['../supabase/migrations/20260730_reminder_delivery_observability.sql'];
    expect(migration).toContain('auth.uid() = user_id');
    expect(migration).toContain('revoke insert, update, delete');
    expect(migration).toContain("'delivery_unconfirmed'");
    expect(migration).toContain("'notification_clicked'");

    const ownerReminderMigration =
      sources['../supabase/migrations/20260811_owner_reminder_whatsapp_delivery.sql'];
    expect(ownerReminderMigration).toContain("'owner_reminder'");
    expect(ownerReminderMigration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(ownerReminderMigration).toContain('WHERE source_type = \'owner_reminder\'');
  });

  it('keeps the focused contract and direct dependencies in the always-on Carson gate', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const protectedScript = [
      packageJson.scripts['pretest:carson-protected'],
      packageJson.scripts['test:carson-protected'],
    ].join(' ');
    for (const focusedTest of [
      'api/owner-whatsapp-reminder-golden-contract.test.js',
      'api/owner-reminder-whatsapp-delivery.test.js',
      'api/owner-reminder-whatsapp-migration.test.js',
      'api/_owner-command-executor.execution.test.js',
      'api/_owner-command-executor.test.js',
      'api/_owner-whatsapp-routing.test.js',
      'api/qstash-reminder.test.js',
      'api/send-push-for-task.test.js',
      'api/send-due-reminder-pushes.test.js',
      'api/_reminder-delivery.test.js',
      'public/sw.test.js',
    ]) {
      expect(protectedScript).toContain(focusedTest);
    }
    const workflow = await readFile(
      new URL('../../.github/workflows/carson-protected-behaviors.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('npm run test:carson-protected');
    expect(workflow).not.toMatch(/^\s+paths:/m);
  });
});

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function emptyResponse(status = 204) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
}
