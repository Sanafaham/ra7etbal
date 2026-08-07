/**
 * Tests for COS Ch. 13.5 Amendment S2 — Indeterminate OLG registration.
 *
 * Verifies that task-confirm.js calls scheduleUncertainOLG (stamps
 * uncertain_olg_registered_at, schedules QStash +4h) when a task enters the
 * Indeterminate state (quality_review_status = 'uncertain' or 'fraud_suspected').
 * Must NOT schedule for correction_required, approved, or substitute_review.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const downloadImageAsBase64Mock = vi.fn();
const runQualityReviewMock = vi.fn();

vi.mock('./_quality-review.js', () => ({
  downloadImageAsBase64: downloadImageAsBase64Mock,
  runQualityReview: runQualityReviewMock,
}));

vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));

let handler;

beforeEach(async () => {
  vi.resetModules();
  ({ default: handler } = await import('./task-confirm.js'));
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
  vi.stubEnv('QSTASH_TOKEN', 'test-qstash-token');
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  downloadImageAsBase64Mock.mockReset().mockResolvedValue('base64-bytes');
  runQualityReviewMock.mockReset();
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

function createReq({ taskId, proofImagePaths } = {}) {
  return {
    method: 'POST',
    body: {
      taskId: taskId ?? 'task-olg',
      proofImagePaths: proofImagePaths ?? ['proof/task-olg/photo1.jpg'],
    },
    headers: {},
    query: {},
  };
}

function jsonResponse(data, status = 200) {
  const text = JSON.stringify(data);
  return {
    ok: status < 400,
    status,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(text),
  };
}

function emptyResponse(status = 200) {
  return {
    ok: status < 400,
    status,
    json: vi.fn().mockResolvedValue([]),
    text: vi.fn().mockResolvedValue('[]'),
  };
}

function buildTaskFetch(task) {
  return jsonResponse([{
    id: 'task-olg',
    user_id: 'user-1',
    status: 'pending',
    description: 'Clean the office',
    assigned_to: 'Ahmed',
    image_path: null,
    quality_review_cycle_count: 0,
    ...task,
  }]);
}

// ─── S2: OLG scheduling for 'uncertain' ─────────────────────────────────────

describe('S2 Amendment — scheduleUncertainOLG called on uncertain review', () => {
  it('stamps uncertain_olg_registered_at and schedules QStash when review is uncertain', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'uncertain', note: 'Cannot determine if done' });

    const fetchMock = vi.fn()
      // 1. GET task
      .mockResolvedValueOnce(buildTaskFetch({}))
      // 2. GET messages (fetchDelegationMessageContent)
      .mockResolvedValueOnce(jsonResponse([]))
      // 3. PATCH save_review — returns 1 row (task still pending)
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-olg' }]))
      // 4. DELETE task_attachments (replaceProofAttachments)
      .mockResolvedValueOnce(emptyResponse())
      // 5. INSERT task_attachments (replaceProofAttachments)
      .mockResolvedValueOnce(emptyResponse())
      // 6. PATCH uncertain_olg_registered_at (scheduleUncertainOLG stamp)
      .mockResolvedValueOnce(emptyResponse())
      // 7. POST QStash
      .mockResolvedValueOnce(jsonResponse({ messageId: 'msg-123' }))
      .mockResolvedValue(emptyResponse());

    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody.outcome).toBe('uncertain');

    // Find the PATCH for uncertain_olg_registered_at
    const olgPatch = fetchMock.mock.calls.find(
      ([url, opts]) =>
        url?.includes('/rest/v1/tasks') &&
        opts?.method === 'PATCH' &&
        JSON.parse(opts.body ?? '{}').uncertain_olg_registered_at,
    );
    expect(olgPatch).toBeDefined();
    expect(JSON.parse(olgPatch[1].body).uncertain_olg_registered_at).toBeDefined();

    // Find the QStash publish call
    const qstashCall = fetchMock.mock.calls.find(
      ([url]) => url?.includes('qstash.upstash.io'),
    );
    expect(qstashCall).toBeDefined();
    const qstashBody = JSON.parse(qstashCall[1].body);
    expect(qstashBody.taskId).toBe('task-olg');
    expect(qstashBody.trigger).toBe('uncertain_olg');
    expect(qstashCall[1].headers['Upstash-Deduplication-Id']).toBe('uncertain-olg-task-olg');
  });

  it('stamps uncertain_olg_registered_at when correctionLimitReached escalates to uncertain', async () => {
    // fraud_suspected + cycleCount already at limit → savedReviewStatus = 'uncertain'
    runQualityReviewMock.mockResolvedValue({ status: 'fraud_suspected', note: 'Looks fake' });

    const fetchMock = vi.fn()
      // 1. GET task (cycle_count=2 → cycleCount becomes 3 → correctionLimitReached)
      .mockResolvedValueOnce(buildTaskFetch({ quality_review_cycle_count: 2 }))
      // 2. GET messages
      .mockResolvedValueOnce(jsonResponse([]))
      // 3. PATCH save_review → 1 row
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-olg' }]))
      // 4. DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse())
      // 5. INSERT task_attachments
      .mockResolvedValueOnce(emptyResponse())
      // 6. PATCH uncertain_olg_registered_at
      .mockResolvedValueOnce(emptyResponse())
      // 7. POST QStash
      .mockResolvedValueOnce(jsonResponse({ messageId: 'msg-456' }))
      .mockResolvedValue(emptyResponse());

    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq(), res);

    // correctionLimitReached → savedReviewStatus = 'uncertain'
    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody.outcome).toBe('uncertain');

    const olgPatch = fetchMock.mock.calls.find(
      ([url, opts]) =>
        url?.includes('/rest/v1/tasks') &&
        opts?.method === 'PATCH' &&
        JSON.parse(opts.body ?? '{}').uncertain_olg_registered_at,
    );
    expect(olgPatch).toBeDefined();
  });
});

// ─── S2: OLG NOT scheduled for non-Indeterminate outcomes ───────────────────

describe('S2 Amendment — scheduleUncertainOLG NOT called for non-Indeterminate outcomes', () => {
  it('does not schedule OLG when review is correction_required', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'correction_required', note: 'Fix the photo' });

    const fetchMock = vi.fn()
      // 1. GET task
      .mockResolvedValueOnce(buildTaskFetch({}))
      // 2. GET messages
      .mockResolvedValueOnce(jsonResponse([]))
      // 3. PATCH save_review → 1 row
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-olg' }]))
      // 4. DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse())
      // 5. INSERT task_attachments
      .mockResolvedValueOnce(emptyResponse())
      // sendCorrectionRequest → multiple fetches (messages insert, whatsapp send, etc.)
      .mockResolvedValue(emptyResponse());

    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq(), res);

    expect(res.json.mock.calls[0][0].outcome).toBe('correction_required');

    const olgPatch = fetchMock.mock.calls.find(
      ([url, opts]) =>
        url?.includes('/rest/v1/tasks') &&
        opts?.method === 'PATCH' &&
        JSON.parse(opts.body ?? '{}').uncertain_olg_registered_at,
    );
    expect(olgPatch).toBeUndefined();

    const qstashCall = fetchMock.mock.calls.find(([url]) => url?.includes('qstash.upstash.io'));
    expect(qstashCall).toBeUndefined();
  });

  it('does not schedule OLG when review is substitute_review', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'substitute_review', note: 'Owner decides' });

    const fetchMock = vi.fn()
      // 1. GET task
      .mockResolvedValueOnce(buildTaskFetch({}))
      // 2. GET messages
      .mockResolvedValueOnce(jsonResponse([]))
      // 3. PATCH save_review → 1 row
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-olg' }]))
      // 4. DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse())
      // 5. INSERT task_attachments
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValue(emptyResponse());

    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq(), res);

    expect(res.json.mock.calls[0][0].outcome).toBe('substitute_review');

    const qstashCall = fetchMock.mock.calls.find(([url]) => url?.includes('qstash.upstash.io'));
    expect(qstashCall).toBeUndefined();
  });
});

// ─── S2: QStash dedup ID is deterministic and colon-free ────────────────────

describe('S2 Amendment — QStash dedup ID is safe for QStash', () => {
  it('dedup ID contains no colon characters (QStash rejects colons)', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'uncertain', note: 'Unclear' });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(buildTaskFetch({}))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-olg' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse({ messageId: 'msg-789' }))
      .mockResolvedValue(emptyResponse());

    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq(), res);

    const qstashCall = fetchMock.mock.calls.find(([url]) => url?.includes('qstash.upstash.io'));
    expect(qstashCall).toBeDefined();
    const dedupId = qstashCall[1].headers['Upstash-Deduplication-Id'];
    expect(dedupId).not.toContain(':');
    expect(dedupId).toMatch(/^uncertain-olg-/);
  });

  it('QStash notBefore is a Unix timestamp in the future (not an ISO string)', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'uncertain', note: 'Unclear' });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(buildTaskFetch({}))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-olg' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse({ messageId: 'msg-abc' }))
      .mockResolvedValue(emptyResponse());

    vi.stubGlobal('fetch', fetchMock);

    const nowUnix = Math.floor(Date.now() / 1000);
    const res = createRes();
    await handler(createReq(), res);

    const qstashCall = fetchMock.mock.calls.find(([url]) => url?.includes('qstash.upstash.io'));
    const notBefore = Number(qstashCall[1].headers['Upstash-Not-Before']);
    expect(Number.isInteger(notBefore)).toBe(true);
    expect(notBefore).toBeGreaterThan(nowUnix);
    // Should be approximately now + 4h = 14400s
    expect(notBefore - nowUnix).toBeGreaterThanOrEqual(14399);
    expect(notBefore - nowUnix).toBeLessThan(14402);
  });
});
