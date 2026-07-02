import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({
  default: {
    sendNotification: vi.fn(),
    setVapidDetails: vi.fn(),
  },
}));

import webpush from 'web-push';
import handler, { PROD_ESCALATE_MS, PROD_FOLLOWUP_MS } from './process-delegation-escalations.js';
import { ESCALATION_DELAY_MS, FOLLOWUP_DELAY_MS } from './qstash-reminder.js';

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'cron-secret');
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
  vi.stubEnv('VAPID_SUBJECT', 'mailto:test@ra7etbal.com');
  vi.stubEnv('APP_BASE_URL', 'https://ra7etbal.com');
  vi.mocked(webpush.sendNotification).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── Protection 1: the two independently-declared delay constants must agree ──
//
// api/qstash-reminder.js computes the per-task QStash notBefore timestamps
// from FOLLOWUP_DELAY_MS / ESCALATION_DELAY_MS. api/process-delegation-
// escalations.js gates the periodic sweep's ageMs re-check with
// PROD_FOLLOWUP_MS / PROD_ESCALATE_MS. Nothing else enforces these four
// numbers stay in sync — a future edit to one without the other would create
// a real window where the per-task trigger and the sweep disagree on when a
// task is "due", the exact category of defect the Follow-Up Timing Bug
// investigation was checking for.
describe('follow-up/escalation delay constants stay in lockstep', () => {
  it('QStash per-task follow-up delay matches the periodic sweep follow-up threshold', () => {
    expect(FOLLOWUP_DELAY_MS).toBe(PROD_FOLLOWUP_MS);
    expect(FOLLOWUP_DELAY_MS).toBe(10 * 60 * 1000);
  });

  it('QStash per-task escalation delay matches the periodic sweep escalation threshold', () => {
    expect(ESCALATION_DELAY_MS).toBe(PROD_ESCALATE_MS);
    expect(ESCALATION_DELAY_MS).toBe(20 * 60 * 1000);
  });
});

// ── Protection 2: a scheduled trigger is a wake-up signal only ──────────────
//
// When QStash delivers the per-task follow-up message, its payload is just
// { taskId } — no action, no proof of eligibility. This must NEVER be trusted
// as authorization to send: the handler must re-derive eligibility from the
// database (ageMs >= threshold, guard column still null) on every invocation,
// exactly as it does for the periodic sweep (whose payload names no task at
// all). This test delivers a per-task-shaped request naming a task that is
// NOT yet old enough, and proves it is not sent — the trigger's mere
// existence/timing is not treated as sufficient.
describe('scheduled triggers cannot bypass the ageMs + guard re-check', () => {
  function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  }
  function emptyResponse(status = 204) {
    return { ok: status >= 200 && status < 300, status, json: async () => null, text: async () => '' };
  }

  function makeFetchMock({ task }) {
    return vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/rest/v1/tasks') && u.includes('select=')) {
        // Candidate fetch for the sweep — return the task regardless of the
        // SQL-level cutoff filter, so this test exercises the APPLICATION
        // layer's own ageMs re-check as a second, independent line of
        // defense, not just the SQL WHERE clause.
        return jsonResponse([task]);
      }
      if (u.includes('/rest/v1/routines')) return jsonResponse([]);
      if (u.includes('/rest/v1/automations')) return jsonResponse([]);
      if (u.includes('/api/send-whatsapp-task')) {
        throw new Error('UNEXPECTED: /api/send-whatsapp-task was called for a not-yet-due task');
      }
      return emptyResponse();
    });
  }

  it('ignores a per-task QStash payload naming a task that is not yet due — no send occurs', async () => {
    const now = new Date('2026-07-02T14:35:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Task created 5 minutes ago — well under the 10-minute follow-up
    // threshold. A real per-task QStash message for THIS task would not even
    // be scheduled to fire for another 5 minutes (notBefore = created + 10
    // min) — but we deliver the request now anyway, exactly as if QStash (or
    // an attacker, or a bug) fired early, to prove the handler itself is the
    // authority, not the trigger's timing.
    const task = {
      id: 'task-too-young',
      user_id: 'user-1',
      description: 'Prepare lunch.',
      type: 'delegation',
      assigned_to: 'Christopher',
      status: 'pending',
      needs_follow_up: true,
      confirmation_url: 'https://ra7etbal.com/confirm?task=task-too-young',
      created_at: '2026-07-02T14:30:00.000Z', // 5 minutes before "now"
      followup_sent_at: null,
      escalated_at: null,
    };

    const fetchMock = makeFetchMock({ task });
    vi.stubGlobal('fetch', fetchMock);

    const req = {
      method: 'POST',
      url: '/api/process-delegation-escalations',
      headers: { authorization: 'Bearer cron-secret', 'user-agent': 'Upstash-QStash' },
      // Real QStash per-task delivery payload — no `action`, just the task
      // this particular trigger was scheduled for.
      body: { taskId: 'task-too-young' },
      query: {},
    };
    let statusCode = null;
    let jsonBody = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { jsonBody = body; return this; },
    };

    await handler(req, res);

    vi.useRealTimers();

    expect(statusCode).toBe(200);
    expect(jsonBody.followupsSent).toBe(0);
    expect(jsonBody.escalationsSent).toBe(0);

    const sendCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/send-whatsapp-task'));
    expect(sendCalls).toHaveLength(0);

    const claimCalls = fetchMock.mock.calls.filter(
      ([u, init]) => String(u).includes('/rest/v1/tasks') && init?.method === 'PATCH',
    );
    expect(claimCalls).toHaveLength(0);
  });

  it('processes a genuinely due task the same way regardless of which taskId the trigger payload names', async () => {
    const now = new Date('2026-07-02T14:45:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Task is 15 minutes old — past the 10-minute follow-up threshold.
    const dueTask = {
      id: 'task-due',
      user_id: 'user-1',
      description: 'Prepare lunch.',
      type: 'delegation',
      assigned_to: 'Christopher',
      status: 'pending',
      needs_follow_up: true,
      confirmation_url: 'https://ra7etbal.com/confirm?task=task-due',
      created_at: '2026-07-02T14:30:00.000Z',
      followup_sent_at: null,
      escalated_at: null,
    };

    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = init.method || 'GET';
      if (u.includes('/rest/v1/tasks') && method === 'PATCH' && u.includes('followup_sent_at=is.null')) {
        return jsonResponse([{ id: dueTask.id, followup_sent_at: now.toISOString() }]);
      }
      if (u.includes('/rest/v1/tasks') && u.includes('select=')) return jsonResponse([dueTask]);
      if (u.includes('/rest/v1/people')) return jsonResponse([{ name: 'Christopher', phone: '+971500000000' }]);
      if (u.includes('/rest/v1/profiles')) return jsonResponse([{ display_name: 'Sana' }]);
      if (u.includes('/api/send-whatsapp-task')) return jsonResponse({ success: true, messageId: 'wamid.1' });
      if (u.includes('/rest/v1/routines')) return jsonResponse([]);
      if (u.includes('/rest/v1/automations')) return jsonResponse([]);
      return emptyResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    // The trigger payload names an ENTIRELY DIFFERENT taskId than the one
    // actually due — proving the handler never uses payload.taskId to select
    // which task to act on. It re-derives everything from its own DB query.
    const req = {
      method: 'POST',
      url: '/api/process-delegation-escalations',
      headers: { authorization: 'Bearer cron-secret', 'user-agent': 'Upstash-QStash' },
      body: { taskId: 'some-other-task-entirely' },
      query: {},
    };
    let jsonBody = null;
    const res = { status() { return this; }, json(body) { jsonBody = body; return this; } };

    await handler(req, res);
    vi.useRealTimers();

    expect(jsonBody.followupsSent).toBe(1);
    const sendCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/send-whatsapp-task'));
    expect(sendCalls).toHaveLength(1);
  });
});
