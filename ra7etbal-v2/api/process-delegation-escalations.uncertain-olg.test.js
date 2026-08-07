/**
 * Tests for COS Ch. 13.5 Amendment S2 — Indeterminate OLG follow-up handler.
 *
 * Verifies that process-delegation-escalations.js correctly handles
 * {trigger: 'uncertain_olg', taskId} QStash payloads:
 * - Task still Indeterminate + not yet escalated → claim guard → push sent
 * - Task no longer Indeterminate (owner resolved) → skip
 * - Task already escalated → skip (idempotent)
 * - Claim guard rejects concurrent invocation → skip
 * - Task not found → skip
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));

vi.mock('./qstash-reminder.js', () => ({
  scheduleAutomationRunWakeup: vi.fn(),
}));

vi.mock('./_owner-whatsapp-routing.js', () => ({
  reconcileOwnerWhatsappMessages: vi.fn().mockResolvedValue(undefined),
}));

// vi.hoisted + reconfigured in beforeEach — afterEach's restoreAllMocks()
// clears any mockResolvedValue set only inside the vi.mock factory, since
// that mock object is reused (not recreated) across this file's
// resetModules()-driven dynamic re-imports.
const personalContactReplyMocks = vi.hoisted(() => ({
  reconcilePersonalContactReplyNotifications: vi.fn(),
}));
vi.mock('./_personal-contact-reply.js', () => personalContactReplyMocks);

let handler;

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  VAPID_PUBLIC_KEY: 'vapid-pub',
  VAPID_PRIVATE_KEY: 'vapid-priv',
  VAPID_SUBJECT: 'mailto:test@test.com',
  CRON_SECRET: 'test-cron',
};

beforeEach(async () => {
  vi.resetModules();
  ({ default: handler } = await import('./process-delegation-escalations.js'));
  Object.entries(ENV).forEach(([k, v]) => vi.stubEnv(k, v));
  personalContactReplyMocks.reconcilePersonalContactReplyNotifications.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

function createReq(body = {}) {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${ENV.CRON_SECRET}` },
    body,
  };
}

function jsonResponse(data, status = 200) {
  return { ok: status < 400, status, json: vi.fn().mockResolvedValue(data) };
}

function emptyPatch() {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue([]) };
}

function claimPatch(rows = [{ id: 'task-1' }]) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(rows) };
}

function buildTask(overrides = {}) {
  return {
    id: 'task-1',
    user_id: 'user-1',
    description: 'Clean the office',
    assigned_to: 'Ahmed',
    status: 'pending',
    quality_review_status: 'uncertain',
    uncertain_escalated_at: null,
    ...overrides,
  };
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('uncertain_olg handler — happy path', () => {
  it('sends owner push and stamps uncertain_escalated_at when task is still Indeterminate', async () => {
    const fetchMock = vi.fn()
      // 1. GET task
      .mockResolvedValueOnce(jsonResponse([buildTask()]))
      // 2. PATCH claim guard → 1 row claimed
      .mockResolvedValueOnce(claimPatch([{ id: 'task-1' }]))
      // 3. GET push subscriptions
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example.com/1', p256dh: 'p256', auth: 'auth' }]))
      .mockResolvedValue(emptyPatch());

    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ trigger: 'uncertain_olg', taskId: 'task-1' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.escalated).toBe(true);

    // Verify claim guard PATCH targeted the right conditions
    const claimCall = fetchMock.mock.calls.find(
      ([url, opts]) =>
        url?.includes('/rest/v1/tasks') &&
        opts?.method === 'PATCH' &&
        JSON.parse(opts.body ?? '{}').uncertain_escalated_at,
    );
    expect(claimCall).toBeDefined();
    expect(claimCall[0]).toContain('uncertain_escalated_at=is.null');
    expect(claimCall[0]).toContain('status=eq.pending');
  });

  it('also handles fraud_suspected Indeterminate state', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([buildTask({ quality_review_status: 'fraud_suspected' })]))
      .mockResolvedValueOnce(claimPatch([{ id: 'task-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example.com/1', p256dh: 'p256', auth: 'auth' }]))
      .mockResolvedValue(emptyPatch());

    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ trigger: 'uncertain_olg', taskId: 'task-1' }), res);

    expect(res.json.mock.calls[0][0].escalated).toBe(true);
  });
});

// ─── Skip cases ───────────────────────────────────────────────────────────────

describe('uncertain_olg handler — skip cases', () => {
  it('skips when task not found', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ trigger: 'uncertain_olg', taskId: 'task-missing' }), res);

    expect(res.json.mock.calls[0][0].skipped).toBe(true);
    expect(res.json.mock.calls[0][0].reason).toBe('task_not_found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips when task status is done (owner approved it)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([buildTask({ status: 'done', quality_review_status: 'approved' })]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ trigger: 'uncertain_olg', taskId: 'task-1' }), res);

    expect(res.json.mock.calls[0][0]).toMatchObject({ skipped: true, reason: 'no_longer_indeterminate' });
    // No claim PATCH should have been called
    const claimCall = fetchMock.mock.calls.find(
      ([, opts]) => opts?.method === 'PATCH',
    );
    expect(claimCall).toBeUndefined();
  });

  it('skips when task quality_review_status changed to approved (still pending)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([buildTask({ quality_review_status: 'approved' })]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ trigger: 'uncertain_olg', taskId: 'task-1' }), res);

    expect(res.json.mock.calls[0][0]).toMatchObject({ skipped: true, reason: 'no_longer_indeterminate' });
  });

  it('skips when uncertain_escalated_at is already set (idempotent)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([buildTask({ uncertain_escalated_at: '2026-08-01T10:00:00Z' })]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ trigger: 'uncertain_olg', taskId: 'task-1' }), res);

    expect(res.json.mock.calls[0][0]).toMatchObject({ skipped: true, reason: 'already_escalated' });
  });

  it('skips when claim guard returns 0 rows (concurrent invocation)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([buildTask()]))
      // Claim guard → 0 rows (another invocation already claimed it)
      .mockResolvedValueOnce(claimPatch([]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ trigger: 'uncertain_olg', taskId: 'task-1' }), res);

    expect(res.json.mock.calls[0][0]).toMatchObject({ skipped: true, reason: 'claim_rejected' });
  });
});

// ─── Routing: non-uncertain_olg payloads fall through ────────────────────────

describe('uncertain_olg routing — non-matching payloads fall through', () => {
  it('does not dispatch uncertain_olg handler when trigger is absent', async () => {
    // No trigger → falls through to the regular cron escalation path
    const fetchMock = vi.fn()
      // tasks query for regular cron path
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({}), res);

    // Regular cron returns checked/followupsSent/escalationsSent
    const body = res.json.mock.calls[0][0];
    expect(body).toHaveProperty('checked');
    expect(body.escalated).toBeUndefined();
  });

  it('does not dispatch when trigger is uncertain_olg but taskId is missing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ trigger: 'uncertain_olg' }), res);

    // Falls through to regular cron
    expect(res.json.mock.calls[0][0]).toHaveProperty('checked');
  });
});
