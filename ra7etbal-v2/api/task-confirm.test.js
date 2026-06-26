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
  vi.stubEnv('APP_BASE_URL', 'https://ra7etbal.com');
  // VAPID env left unset so sendOwnerPush short-circuits before any fetch —
  // owner push delivery itself is covered by other tests; here we only care
  // about the Quality Intelligence routing.
  downloadImageAsBase64Mock.mockReset().mockResolvedValue('base64-bytes');
  runQualityReviewMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Quality Intelligence V1 — task-confirm POST routing', () => {
  it('skips review entirely when no proof photo is submitted (unchanged behavior)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'd', assigned_to: 'Christopher', image_path: null }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1' }), res);

    expect(runQualityReviewMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, outcome: 'approved' }),
    );
    const patchBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(patchBody.status).toBe('done');
    expect(patchBody.quality_review_status).toBeUndefined();
  });

  it('skips review for a personal task with no assignee even if a proof photo is submitted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'd', assigned_to: null, image_path: null }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/user-1/task-1/proof.jpg' }), res);

    expect(runQualityReviewMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
  });

  it('approved review: marks the task done and records the review outcome', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Matches the reference.' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please plate the chicken like the photo.' }])) // messages lookup
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof.jpg' }),
      res,
    );

    expect(runQualityReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskDescription: 'plate the chicken',
        delegationMessage: 'Please plate the chicken like the photo.',
        referenceImageBase64: 'base64-bytes',
        proofImageBase64: 'base64-bytes',
      }),
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBe('done');
    expect(patchBody.quality_review_status).toBe('approved');
  });

  it('correction_required review: keeps the task pending and sends a WhatsApp correction to the assignee', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, please center the chicken and send another photo.',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please plate the chicken like the photo.' }])) // messages lookup
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks (stays pending, review fields)
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '971500000000', whatsapp_opted_in: true }])) // people lookup
      .mockResolvedValueOnce(jsonResponse({ success: true })); // send-whatsapp-task call
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof.jpg' }),
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, outcome: 'correction_required' }),
    );

    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBeUndefined();
    expect(patchBody.quality_review_status).toBe('correction_required');
    expect(patchBody.quality_review_note).toBe('Christopher, please center the chicken and send another photo.');
    expect(patchBody.proof_image_path).toBe('task-images/u/t/proof.jpg');

    expect(String(fetchMock.mock.calls[4][0])).toContain('https://ra7etbal.com/api/send-whatsapp-task');
    const sendBody = JSON.parse(fetchMock.mock.calls[4][1].body);
    expect(sendBody).toEqual(
      expect.objectContaining({
        to: '971500000000',
        messageText: 'Christopher, please center the chicken and send another photo.',
        sendMode: 'direct_message',
        recipientName: 'Christopher',
      }),
    );

    // No "done" PATCH and no confirmations row for a correction-required outcome.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
  });

  it('correction_required review: does not send WhatsApp when the assignee has no consent', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'correction_required', note: 'Please fix the placement.' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'd', assigned_to: 'Christopher', image_path: null }]))
      .mockResolvedValueOnce(jsonResponse([])) // no messages row
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '971500000000', whatsapp_opted_in: false }])); // no consent
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'correction_required' }));
    expect(fetchMock).toHaveBeenCalledTimes(4); // no send-whatsapp-task call attempted
  });

  it('uncertain review: keeps the task pending without sending any WhatsApp message', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'uncertain',
      note: 'No reference image and the description is too vague to judge.',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'tidy the room', assigned_to: 'Grace', image_path: null }]))
      .mockResolvedValueOnce(jsonResponse([])) // no messages row
      .mockResolvedValueOnce(emptyResponse()); // PATCH tasks
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, outcome: 'uncertain' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.quality_review_status).toBe('uncertain');
    expect(patchBody.status).toBeUndefined();
    // No send-whatsapp-task call and no confirmations row for an uncertain outcome.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
  });

  it('is idempotent — an already-done task short-circuits before any review runs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'done', description: 'd', assigned_to: 'Christopher', image_path: null }]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof.jpg' }), res);

    expect(runQualityReviewMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ already_done: true }));
  });
});

function createReq(body, headers = {}) {
  return {
    method: 'POST',
    headers,
    body,
  };
}

function createRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(''),
  };
}
