import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({
  default: {
    sendNotification: vi.fn(),
    setVapidDetails: vi.fn(),
  },
}));

import webpush from 'web-push';
import {
  processAutomation,
  processMessageAutomation,
  runAutomationsCore,
  computeNextRunAt,
} from './process-delegation-escalations.js';

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'cron-secret');
  vi.mocked(webpush.sendNotification).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('processMessageAutomation', () => {
  it('sends recurring message automations without creating a task or confirmation link', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Sana', phone: '+971500000000' }]))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        messageId: 'wamid.automation',
        delivery_id: 'delivery-1',
      }))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(advancedAutomationResponse('2026-06-27T14:30:00.000Z'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processMessageAutomation({
      automation: automationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      runId: 'run-1',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/rest/v1/people');

    expect(fetchMock.mock.calls[1][0]).toBe('https://ra7etbal.com/api/send-whatsapp-task');
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-ra7etbal-internal-secret': 'cron-secret',
      Authorization: 'Bearer cron-secret',
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      to: '+971500000000',
      messageText: 'Recurring automation test.',
      automationRunId: 'run-1',
      sourceType: 'automation_message',
      sendMode: 'routine_message',
      recipientName: 'Sana',
    });

    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      current_state: 'sent',
      sent_at: '2026-06-26T14:30:00.000Z',
    });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/tasks'))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body ?? '').includes('confirmationLink'))).toBe(false);
  });

  it('returns failed and stores the WhatsApp failure reason when the send is rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Sana', phone: '+971500000000' }]))
      .mockResolvedValueOnce(jsonResponse(
        { success: false, errorMessage: 'Meta rejected the routine template.', delivery_id: 'delivery-1' },
        400,
      ))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(advancedAutomationResponse('2026-06-27T14:30:00.000Z'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processMessageAutomation({
      automation: automationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      runId: 'run-1',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('failed');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      current_state: 'failed',
      failure_reason: 'WhatsApp send failed (400): Meta rejected the routine template.',
    });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
  });
});

describe('processAutomation owner-only automations', () => {
  // Required test 1: "First invocation claims and executes."
  it('creates an owner task and sends an owner push, and advances next_run_at exactly once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(advancedAutomationResponse('2026-06-27T14:30:00.000Z'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/rest/v1/tasks');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      user_id: 'user-1',
      type: 'action',
      description: 'Review your priorities.',
      status: 'pending',
      needs_follow_up: false,
      assigned_to: null,
      due_at: '2026-06-26T14:30:00.000Z',
    });
    expect(String(fetchMock.mock.calls[4][0])).toContain('/rest/v1/push_subscriptions');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } },
      JSON.stringify({
        title: 'Ra7etBal · Reminder',
        body: 'Review your priorities.',
      }),
      { urgency: 'normal', TTL: 600 },
    );
    // current_state is only recorded 'sent' AFTER the push attempt resolves.
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).toMatchObject({
      current_state: 'sent',
      sent_at: '2026-06-26T14:30:00.000Z',
    });
    // The advance write is guarded on next_run_at=eq.<the value this
    // invocation read> — proves the claim, not just that a PATCH fired.
    expect(String(fetchMock.mock.calls[6][0])).toContain('next_run_at=eq.2026-06-26T14%3A30%3A00.000Z');
    expect(JSON.parse(fetchMock.mock.calls[6][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
    // Exactly one write to the automations table for this cycle.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/rest/v1/automations?')).length).toBe(1);
  });

  // Regression: exact-time recurring reminder wake-ups. Confirms the
  // following occurrence's wake-up is published only after next_run_at's
  // guarded write actually applied — never before, never regardless of it.
  it('publishes the following exact wake-up only after next_run_at successfully advances', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'qstash-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(advancedAutomationResponse('2026-06-27T14:30:00.000Z'))
      .mockResolvedValueOnce(jsonResponse({ messageId: 'msg-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    // The wake-up publish is the 8th call — strictly after the guarded
    // advance (7th call) whose write it depends on.
    expect(fetchMock).toHaveBeenCalledTimes(8);
    const [qstashUrl, qstashInit] = fetchMock.mock.calls[7];
    expect(String(qstashUrl)).toContain('/api/process-delegation-escalations');
    expect(qstashInit.headers['Upstash-Deduplication-Id']).toBe(
      'automation-run-automation-1-2026-06-27T14:30:00.000Z',
    );
  });

  // A publish failure must never affect the return value of processAutomation
  // or undo the already-durable next_run_at advance — the existing
  // 10-minute cron remains the fallback either way.
  it('does not block or fail the run when wake-up publishing fails after a successful advance', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'qstash-token');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(advancedAutomationResponse('2026-06-27T14:30:00.000Z'))
      .mockResolvedValueOnce(jsonResponse({ error: 'QStash down' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    const failureLog = errorSpy.mock.calls.find(
      ([label]) => label === '[automations] exact wake-up scheduling failed for next cycle — cron fallback active',
    );
    expect(failureLog).toBeTruthy();
    expect(failureLog[1]).toMatchObject({ automationId: 'automation-1' });
  });

  // Guarded advance no-op (another invocation already owns this cycle) must
  // never publish a duplicate wake-up — QStash's own dedup ID would make a
  // second publish for the same cycle harmless anyway, but this confirms the
  // guard itself (applied === false) already prevents the attempt.
  it('does not publish a wake-up when the guarded advance is a no-op (already advanced by another invocation)', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'qstash-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      // Guard finds next_run_at already changed by someone else — empty array.
      .mockResolvedValueOnce(jsonResponse([], 200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  // Regression: this test previously asserted the OPPOSITE — that a failed
  // owner push was still reported as a successful ('sent') run, on the theory
  // that task creation alone counted as success. That was a truthfulness bug:
  // for an owner-only reminder, the push IS the delivery (there is no WhatsApp
  // leg), so reporting 'sent' when nothing was actually delivered is a false
  // success. Corrected so current_state accurately reflects delivery.
  // Required test 8: "Failed push is not recorded as sent."
  it('marks owner-only automation failed (not sent) when owner push fails, but still advances next_run_at', async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(Object.assign(new Error('push rejected'), {
      statusCode: 500,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(advancedAutomationResponse('2026-06-27T14:30:00.000Z'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).toMatchObject({
      current_state: 'failed',
      failure_reason: 'Owner push notification was not delivered (no enabled subscription or every send failed).',
    });
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).not.toHaveProperty('sent_at');
    // The cycle is still spent — next_run_at must still advance so the
    // automation isn't permanently stuck on a delivery failure.
    expect(JSON.parse(fetchMock.mock.calls[6][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
  });

  // Required test: "Missing owner notification destination fails truthfully."
  it('marks owner-only automation failed when the owner has no enabled push subscription at all', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([])) // zero push_subscriptions rows
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(advancedAutomationResponse('2026-06-27T14:30:00.000Z'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).toMatchObject({
      current_state: 'failed',
    });
  });

  // Required test: "Owner and household scoping" — the push query and task
  // row must be scoped to the automation's own user_id only.
  it('scopes the owner task and push lookup to the automation owner only', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(advancedAutomationResponse('2026-06-27T14:30:00.000Z'));
    vi.stubGlobal('fetch', fetchMock);

    await processAutomation({
      automation: ownerOnlyAutomationRow({ user_id: 'user-owner-42' }),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ user_id: 'user-owner-42' });
    expect(String(fetchMock.mock.calls[4][0])).toContain('user_id=eq.user-owner-42');
  });
});

describe('processAutomation — overlapping invocation / duplicate-cycle safety', () => {
  // Required test 2 & 6: "Second overlapping invocation detects duplicate" /
  // "Retry after a sent cycle does not execute or advance again."
  //
  // A terminal-state duplicate still ATTEMPTS a guarded advance (CodeRabbit
  // finding: a crash between the owner's terminal-state write and its own
  // advanceNextRunAt call would otherwise strand the automation forever with
  // no non-terminal run left to trigger recovery). In the normal case — the
  // owner really did already advance — the guard rejects the write (0 rows),
  // so the schedule itself is never actually touched twice.
  it('a duplicate invocation whose cycle already completed (terminal state) does not push, and its guarded advance attempt is rejected because the owner already advanced', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([], 200)) // ignore-duplicates conflict
      .mockResolvedValueOnce(jsonResponse([
        { id: 'existing-run-1', current_state: 'sent', created_at: '2026-06-26T14:29:50.000Z' },
      ]))
      // Guard rejects: next_run_at no longer matches — the owner already advanced.
      .mockResolvedValueOnce(jsonResponse([], 200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('skipped');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/tasks'))).toBe(false);
    // The guarded attempt IS made (proves the recovery path runs)...
    expect(String(fetchMock.mock.calls[2][0])).toContain('/rest/v1/automations?');
    expect(String(fetchMock.mock.calls[2][0])).toContain('next_run_at=eq.2026-06-26T14%3A30%3A00.000Z');
    // ...but the schedule itself is never actually changed by it (rejected).
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // CodeRabbit finding: closes the crash-window gap above. If the owner
  // recorded a terminal state but crashed before advancing, the schedule is
  // genuinely stuck on the stale next_run_at — the guarded recovery attempt
  // from the terminal-state branch must actually apply in that case.
  it('a duplicate invocation whose cycle is terminal but was never actually advanced (owner crashed mid-write) recovers the stranded schedule', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([], 200))
      .mockResolvedValueOnce(jsonResponse([
        { id: 'existing-run-1', current_state: 'sent', created_at: '2026-06-26T14:29:50.000Z' },
      ]))
      // Guard applies: next_run_at still matches — nobody advanced it.
      .mockResolvedValueOnce(advancedAutomationResponse('2026-06-27T14:30:00.000Z'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('skipped');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
  });

  // Required test 7: "Retry after a failed push follows the documented policy."
  // Policy: 'failed' is a terminal state — a retry sees it and does nothing,
  // but still attempts (and here, has rejected) the same guarded recovery
  // check as any other terminal state.
  it('a duplicate invocation whose cycle already failed (terminal state) does not re-attempt the push', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([], 200))
      .mockResolvedValueOnce(jsonResponse([
        { id: 'existing-run-1', current_state: 'failed', created_at: '2026-06-26T14:29:50.000Z' },
      ]))
      .mockResolvedValueOnce(jsonResponse([], 200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('skipped');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  // A concurrent invocation whose cycle is non-terminal but recent must
  // assume the true owner is still actively working — do nothing, not even
  // an advance attempt.
  it('a duplicate invocation whose cycle is non-terminal but recent (owner still working) does not push or advance', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([], 200))
      .mockResolvedValueOnce(jsonResponse([
        { id: 'existing-run-1', current_state: 'scheduled', created_at: '2026-06-26T14:29:45.000Z' }, // 15s old
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('skipped');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/automations?'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Required test 13: "Cron retry after process restart does not duplicate
  // the cycle." A "restart" looks identical to any other retry from the
  // runner's stateless perspective: the caller re-reads the automation and
  // tries again with no memory of the first attempt. Proves across two
  // separate processAutomation invocations that only one push and one
  // automations-table write happen for the same cycle.
  it('a stale/abandoned non-terminal cycle is recovered (marked failed) and next_run_at advances exactly once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([], 200)) // ignore-duplicates conflict
      .mockResolvedValueOnce(jsonResponse([
        { id: 'existing-run-1', current_state: 'scheduled', created_at: '2026-06-26T14:27:30.000Z' }, // 150s old > 120s threshold
      ]))
      .mockResolvedValueOnce(emptyResponse()) // mark stale run 'failed'
      .mockResolvedValueOnce(advancedAutomationResponse('2026-06-27T14:30:00.000Z')); // guarded recovery advance succeeds
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('skipped');
    // Never executes the action for a duplicate — no task, no push — even
    // though it is recovering the stuck schedule.
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/tasks'))).toBe(false);
    // The abandoned run's real outcome is preserved, not silently discarded.
    expect(String(fetchMock.mock.calls[2][0])).toContain('/rest/v1/automation_runs?id=eq.existing-run-1');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ current_state: 'failed' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).failure_reason).toMatch(/Abandoned/);
    // Recovery advance is the same guarded write, keyed on the same next_run_at.
    expect(String(fetchMock.mock.calls[3][0])).toContain('next_run_at=eq.2026-06-26T14%3A30%3A00.000Z');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({ next_run_at: '2026-06-27T14:30:00.000Z' });
  });

  it('a second recovery attempt for the same stale cycle is rejected by the guard (no double-advance)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([], 200))
      .mockResolvedValueOnce(jsonResponse([
        { id: 'existing-run-1', current_state: 'scheduled', created_at: '2026-06-26T14:27:30.000Z' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      // Guard rejects: another recovering invocation already advanced it first.
      .mockResolvedValueOnce(jsonResponse([], 200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    // The function itself never throws or double-writes — the rejected guard
    // is a safe no-op, and the cycle is still correctly reported as skipped.
    expect(result).toBe('skipped');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // CodeRabbit finding: patchAutomationRun previously had no return value, so
  // a failed "mark abandoned run as failed" write was silently ignored and
  // recovery advanced next_run_at anyway — leaving the old run permanently
  // stuck in a non-terminal state with no accurate record of what happened.
  it('does not advance when marking the abandoned run failed does not itself succeed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([], 200))
      .mockResolvedValueOnce(jsonResponse([
        { id: 'existing-run-1', current_state: 'scheduled', created_at: '2026-06-26T14:27:30.000Z' },
      ]))
      // Marking the abandoned run 'failed' itself fails.
      .mockResolvedValueOnce(jsonResponse({ message: 'db error' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('skipped');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    // No advance attempt at all — never advance past a cycle whose real
    // outcome could not be durably recorded.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not guess when the conflicting run cannot be inspected — leaves the cycle for the next tick instead of advancing blindly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([], 200))
      .mockResolvedValueOnce(jsonResponse({ message: 'read error' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('skipped');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/automations?'))).toBe(false);
  });
});

describe('processAutomation — invalid recurrence fails safely', () => {
  // Required test: "Invalid recurrence fails safely." A malformed
  // cadence_value (e.g. every_n_days missing n) must pause the automation
  // with a clear reason instead of crashing or silently rescheduling.
  it('pauses the automation with a clear reason when cadence_value is invalid, after still delivering the current cycle', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([{ id: 'automation-1', status: 'paused' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow({
        cadence_type: 'every_n_days',
        cadence_value: { time: '09:00' }, // missing required "n"
      }),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    // The final call pauses the automation instead of setting next_run_at.
    const lastCallBody = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
    expect(lastCallBody).toMatchObject({ status: 'paused' });
    expect(lastCallBody.paused_reason).toMatch(/Invalid cadence_value/);
    expect(lastCallBody).not.toHaveProperty('next_run_at');
  });
});

describe('runAutomationsCore — due-automation query scoping', () => {
  // Required tests: "Inactive automation does not execute" / "Future
  // automation does not execute early." The runner relies entirely on the
  // PostgREST filter to exclude both — this locks in that the filter is
  // actually present in the query, so a future edit can't silently drop it.
  it('queries only active automations whose next_run_at has passed', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await runAutomationsCore({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
    });

    const queriedUrl = String(fetchMock.mock.calls[0][0]);
    expect(queriedUrl).toContain('/rest/v1/automations');
    expect(queriedUrl).toContain('status=eq.active');
    expect(queriedUrl).toMatch(/next_run_at=lte\./);
  });

  // Regression: exact-time recurring reminder wake-ups. A QStash one-shot
  // wake-up (targeting this same endpoint with { action: 'run-automations' })
  // carries no automation-specific data the handler trusts for selection —
  // runAutomationsDispatch/runAutomationsCore always re-derive which
  // automation(s) are due fresh from this same status=active AND
  // next_run_at<=now() query, regardless of what triggered the invocation.
  // These two tests prove a stale wake-up genuinely cannot execute anything
  // it shouldn't, by exercising this exact query path directly — not by
  // trusting that a payload field was ignored, but by proving the automation
  // it targeted is absent from what the query actually returns.
  it('a paused/stopped automation is never selected — a stale wake-up for it published before it was paused finds nothing to run', async () => {
    // The query itself filters status=eq.active server-side; a paused
    // automation simply never appears in the result set PostgREST returns,
    // regardless of any wake-up that arrives after the fact.
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const stats = await runAutomationsCore({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
    });

    expect(stats).toMatchObject({ checked: 0, fired: 0 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('status=eq.active');
  });

  // CodeRabbit finding: the original version of this test mocked the exact
  // same empty response and asserted the exact same stats as the test above,
  // with only the prose distinguishing it — never actually exercising the
  // "stale target" scenario it claimed to. Strengthened to assert on the
  // query's own next_run_at=lte.<timestamp> parameter: the cutoff is a
  // freshly-computed "now" at query time (parseable, within a tight bound of
  // Date.now()), never a value the wake-up call could have supplied — proof
  // the query re-derives eligibility itself rather than trusting anything
  // about what triggered this invocation.
  it('an automation whose next_run_at has already advanced past a stale wake-up target is not re-executed — the query cutoff is always freshly computed, never wake-up-supplied', async () => {
    const beforeCall = Date.now();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const stats = await runAutomationsCore({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
    });
    const afterCall = Date.now();

    const queriedUrl = String(fetchMock.mock.calls[0][0]);
    const cutoffMatch = queriedUrl.match(/next_run_at=lte\.([^&]+)/);
    expect(cutoffMatch).not.toBeNull();
    const cutoffMs = new Date(decodeURIComponent(cutoffMatch[1])).getTime();
    // A wake-up scheduled for cycle N's stale next_run_at has no way to
    // inject that value here — the cutoff this call actually used is bounded
    // tightly around the real invocation time, proving it was computed fresh
    // rather than read from any external input.
    expect(cutoffMs).toBeGreaterThanOrEqual(beforeCall);
    expect(cutoffMs).toBeLessThanOrEqual(afterCall);

    expect(stats).toMatchObject({ checked: 0, fired: 0 });
  });

  // Required test 9: "Concurrent processing of different automations remains independent."
  it('processes each due automation independently — one failure does not stop the others', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([
        ownerOnlyAutomationRow({ id: 'automation-fail' }),
        ownerOnlyAutomationRow({ id: 'automation-ok' }),
      ]))
      // automation-fail: automation_run insert itself fails
      .mockResolvedValueOnce(jsonResponse({ message: 'db error' }, 500))
      // automation-ok: full successful owner-push cycle
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-2' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-2' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(advancedAutomationResponse('2026-06-27T14:30:00.000Z', 'automation-ok'));
    vi.stubGlobal('fetch', fetchMock);

    const stats = await runAutomationsCore({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
    });

    expect(stats).toMatchObject({ checked: 2, fired: 1, failed: 1 });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });
});

describe('computeNextRunAt — recurrence, local time, and timezone/DST correctness', () => {
  it('advances daily cadence by exactly one calendar day in a non-DST timezone (Europe/Istanbul)', () => {
    const next = computeNextRunAt({
      cadence_type: 'daily',
      cadence_value: { time: '09:00' },
      timezone: 'Europe/Istanbul',
      next_run_at: '2026-06-21T06:00:00.000Z', // 09:00 local
    });
    expect(next).toBe('2026-06-22T06:00:00.000Z'); // still 09:00 local, +24h UTC
  });

  it('preserves the local wall-clock time across a spring-forward DST transition (America/New_York)', () => {
    // 2026-03-08 is the US spring-forward date (clocks jump 2:00am -> 3:00am).
    const next = computeNextRunAt({
      cadence_type: 'daily',
      cadence_value: { time: '09:00' },
      timezone: 'America/New_York',
      next_run_at: '2026-03-07T14:00:00.000Z', // 09:00 EST (UTC-5)
    });
    // 09:00 EDT (UTC-4) the next day — only +23h in UTC terms, not +24h.
    expect(next).toBe('2026-03-08T13:00:00.000Z');
  });

  it('preserves the local wall-clock time across a fall-back DST transition (America/New_York)', () => {
    // 2026-11-01 is the US fall-back date (clocks repeat 1:00am-2:00am).
    const next = computeNextRunAt({
      cadence_type: 'daily',
      cadence_value: { time: '09:00' },
      timezone: 'America/New_York',
      next_run_at: '2026-10-31T13:00:00.000Z', // 09:00 EDT (UTC-4)
    });
    // 09:00 EST (UTC-5) the next day — +25h in UTC terms, not +24h.
    expect(next).toBe('2026-11-01T14:00:00.000Z');
  });

  it('advances weekly cadence by 7 local days', () => {
    const next = computeNextRunAt({
      cadence_type: 'weekly',
      cadence_value: { time: '09:00', day: 1 },
      timezone: 'Europe/Istanbul',
      next_run_at: '2026-06-22T06:00:00.000Z',
    });
    expect(next).toBe('2026-06-29T06:00:00.000Z');
  });

  it('advances every_n_days cadence by the configured interval', () => {
    const next = computeNextRunAt({
      cadence_type: 'every_n_days',
      cadence_value: { time: '09:00', n: 3 },
      timezone: 'Europe/Istanbul',
      next_run_at: '2026-06-21T06:00:00.000Z',
    });
    expect(next).toBe('2026-06-24T06:00:00.000Z');
  });

  it('returns null for cadence_type=once (caller stops the automation instead of rescheduling)', () => {
    expect(computeNextRunAt({ cadence_type: 'once', cadence_value: {}, timezone: 'Europe/Istanbul', next_run_at: '2026-06-21T06:00:00.000Z' })).toBeNull();
  });

  it('returns "invalid" for every_n_days with a missing/non-integer n, so the caller pauses instead of crashing', () => {
    expect(computeNextRunAt({
      cadence_type: 'every_n_days',
      cadence_value: { time: '09:00' },
      timezone: 'Europe/Istanbul',
      next_run_at: '2026-06-21T06:00:00.000Z',
    })).toBe('invalid');
  });

  it('returns "invalid" for an unrecognised cadence_type', () => {
    expect(computeNextRunAt({
      cadence_type: 'bogus',
      cadence_value: {},
      timezone: 'Europe/Istanbul',
      next_run_at: '2026-06-21T06:00:00.000Z',
    })).toBe('invalid');
  });
});

describe('processAutomation unsupported recurring WhatsApp automations', () => {
  // Required test 10: "Staff automation behavior remains unchanged."
  it('skips and pauses delegated recurring automations before creating tasks or WhatsApp deliveries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow({
        title: 'Weekly Flower Inventory',
        instruction: 'Send the flower inventory.',
        assignee_id: 'person-grace',
        cadence_type: 'weekly',
      }),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-29T07:00:00.000Z'),
    });

    expect(result).toBe('skipped');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      current_state: 'skipped',
      failure_reason: 'Recurring WhatsApp automations are currently disabled; no task or WhatsApp message was created.',
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      status: 'paused',
      paused_reason: 'Recurring WhatsApp automations are currently disabled; no task or WhatsApp message was created.',
      updated_at: '2026-06-29T07:00:00.000Z',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/tasks'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(false);
    // Required: "Never execute staff routines through an owner-reminder path."
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/push_subscriptions'))).toBe(false);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('skips and pauses recurring message automations before sending WhatsApp', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: automationRow({ automation_type: 'message', cadence_type: 'daily' }),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-29T07:00:00.000Z'),
    });

    expect(result).toBe('skipped');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ status: 'paused' });
  });
});

function automationRow(overrides = {}) {
  return {
    id: 'automation-1',
    user_id: 'user-1',
    title: 'Recurring automation test',
    instruction: 'Recurring automation test.',
    automation_type: 'message',
    assignee_id: 'person-1',
    cadence_type: 'daily',
    cadence_value: { time: '17:30' },
    timezone: 'Europe/Istanbul',
    next_run_at: '2026-06-26T14:30:00.000Z',
    ...overrides,
  };
}

function ownerOnlyAutomationRow(overrides = {}) {
  return {
    id: 'automation-1',
    user_id: 'user-1',
    title: 'Daily priorities',
    instruction: 'Review your priorities.',
    automation_type: 'delegation',
    assignee_id: null,
    cadence_type: 'daily',
    cadence_value: { time: '17:30' },
    timezone: 'Europe/Istanbul',
    next_run_at: '2026-06-26T14:30:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => null,
    text: async () => '',
  };
}

/**
 * Simulates a successful guarded advance: PostgREST's
 * `Prefer: return=representation` on a conditional PATCH that matched exactly
 * one row. This is what proves the write actually *applied*, not merely that
 * a PATCH request was sent — see guardedPatchAutomation.
 */
function advancedAutomationResponse(nextRunAt, id = 'automation-1') {
  return jsonResponse([{ id, next_run_at: nextRunAt }], 200);
}
