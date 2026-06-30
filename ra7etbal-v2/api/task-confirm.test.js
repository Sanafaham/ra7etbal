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

  it('correction_required review: keeps task pending, returns QI note for on-page display, sends no WhatsApp', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, please center the chicken and send another photo.',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please plate the chicken like the photo.' }])) // messages lookup (delegation content)
      .mockResolvedValueOnce(emptyResponse()); // PATCH tasks (stays pending, review fields)
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof.jpg' }),
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        outcome: 'correction_required',
        correctionNote: 'Christopher, please center the chicken and send another photo.',
        correctionCycleCount: 1,
      }),
    );

    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBeUndefined(); // task NOT marked done
    expect(patchBody.quality_review_status).toBe('correction_required');
    expect(patchBody.quality_review_note).toBe('Christopher, please center the chicken and send another photo.');
    expect(patchBody.proof_image_path).toBe('task-images/u/t/proof.jpg');
    expect(patchBody.quality_review_cycle_count).toBe(1);

    // No WhatsApp sent — correction is shown inline on the confirmation page.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
    // No owner push for correction_required.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    // No confirmations row.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
    // Only 3 fetch calls total: task, messages lookup, PATCH.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('correction_required: no WhatsApp, no owner push — QI note returned for on-page display', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, the chicken is not centered. Please retake the photo.',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Plate the chicken like the reference photo.' }])) // messages lookup
      .mockResolvedValueOnce(emptyResponse()); // PATCH tasks
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        outcome: 'correction_required',
        correctionNote: 'Christopher, the chicken is not centered. Please retake the photo.',
        correctionCycleCount: 1,
      }),
    );
    // No WhatsApp — correction shown inline on confirmation page.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
    // No owner push.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('correction_required second submission: still no WhatsApp, no owner push, cycle count increments', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, please center the chicken again.',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg', quality_review_cycle_count: 1 }]))
      .mockResolvedValueOnce(jsonResponse([])) // messages lookup
      .mockResolvedValueOnce(emptyResponse()); // PATCH tasks (cycle count -> 2)
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof2.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        outcome: 'correction_required',
        correctionCycleCount: 2,
      }),
    );
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.quality_review_cycle_count).toBe(2);
    expect(patchBody.status).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('uncertain review: keeps the task pending, sends no WhatsApp message, and triggers the owner-push path', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'uncertain',
      note: 'No reference image and the description is too vague to judge.',
    });
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:owner@example.com');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'tidy the room', assigned_to: 'Grace', image_path: null }]))
      .mockResolvedValueOnce(jsonResponse([])) // no messages row
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }])); // push_subscriptions lookup
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, outcome: 'uncertain', correctionCycleCount: 1 }),
    );
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.quality_review_status).toBe('uncertain');
    expect(patchBody.status).toBeUndefined();
    expect(patchBody.quality_review_cycle_count).toBe(1);
    // No send-whatsapp-task call and no confirmations row for an uncertain outcome.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
    // Owner-push path was attempted (push_subscriptions lookup ran).
    expect(String(fetchMock.mock.calls[3][0])).toContain('/rest/v1/push_subscriptions');
  });

  it('cycle count increments only for non-approved outcomes — approved leaves it untouched', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Matches the reference.' });
    const fetchMock = vi
      .fn()
      // Task had one prior correction round before this approved resubmission.
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg', quality_review_cycle_count: 1 }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please plate the chicken like the photo.' }])) // messages lookup
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof2.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBe('done');
    expect(patchBody.quality_review_status).toBe('approved');
    // Approved outcomes do not touch the cycle count — it is left as-is, not reset.
    expect(patchBody.quality_review_cycle_count).toBeUndefined();
  });

  it('fraud_suspected review (reused reference image): keeps the task pending, notifies the owner only, never the assignee', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'fraud_suspected',
      note: 'This is the same image as the reference photo, not a new photo of the completed task.',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'look for this in the closet', assigned_to: 'Grace', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([])) // no messages row
      .mockResolvedValueOnce(emptyResponse()); // PATCH tasks
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, outcome: 'fraud_suspected' }),
    );
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.quality_review_status).toBe('fraud_suspected');
    expect(patchBody.status).toBeUndefined();
    // Never sends a WhatsApp message to the assignee for fraud_suspected —
    // only the owner is notified, and only the owner decides whether to
    // follow up with the assignee.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
  });

  it('fraud_suspected review (screenshot proof): same owner-only routing as a reused reference image', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'fraud_suspected',
      note: 'This looks like a screenshot of a product listing, not a photo of the item.',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-2', user_id: 'user-1', status: 'pending', description: 'buy the pearl bracelet shown', assigned_to: 'Grace', image_path: 'task-images/u/t2/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([])) // no messages row
      .mockResolvedValueOnce(emptyResponse()); // PATCH tasks
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-2', proofImagePath: 'task-images/u/t2/proof.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, outcome: 'fraud_suspected' }),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
  });

  // ── The 4 required production scenarios ──────────────────────────────────

  it('scenario Pizza→Pizza: approved, task done, owner push fires once', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Matches the reference.' });
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:owner@example.com');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'get the pizza', assigned_to: 'Christopher', image_path: 'task-images/u/t/pizza.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please bring the pizza.' }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()) // confirmations insert
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }])); // push (approved)
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof-pizza.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBe('done');
    // Owner push fires for approved.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(true);
    // No correction WhatsApp.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
  });

  it('scenario Pizza→Salad: QI note returned inline, task open, NO WhatsApp, NO owner push', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, that is a salad, not the pizza. Please bring the correct item.',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'get the pizza', assigned_to: 'Christopher', image_path: 'task-images/u/t/pizza.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please bring the pizza.' }]))
      .mockResolvedValueOnce(emptyResponse()); // PATCH tasks (stays pending)
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof-salad.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'correction_required',
      correctionNote: 'Christopher, that is a salad, not the pizza. Please bring the correct item.',
    }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBeUndefined(); // task NOT marked done
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('scenario Pizza→Salad→Salad: second wrong proof, still no WhatsApp, task open, NO owner push', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, that is still a salad. Please bring the pizza.',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'get the pizza', assigned_to: 'Christopher', image_path: 'task-images/u/t/pizza.jpg', quality_review_cycle_count: 1 }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please bring the pizza.' }]))
      .mockResolvedValueOnce(emptyResponse()); // PATCH tasks (still pending, cycle -> 2)
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof-salad2.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'correction_required', correctionCycleCount: 2 }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBeUndefined(); // still NOT done
    expect(patchBody.quality_review_cycle_count).toBe(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('scenario Pizza→Salad→Pizza: task done on final approval, owner push fires once for the approval', async () => {
    // First call: correction round (tested separately above).
    // This test covers the FINAL approved submission.
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Pizza confirmed.' });
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:owner@example.com');

    const fetchMock = vi
      .fn()
      // Task has one prior correction cycle recorded.
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'get the pizza', assigned_to: 'Christopher', image_path: 'task-images/u/t/pizza.jpg', quality_review_cycle_count: 1 }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please bring the pizza.' }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()) // confirmations insert
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }])); // push (approved)
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePath: 'task-images/u/t/proof-pizza.jpg' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBe('done');
    expect(patchBody.quality_review_status).toBe('approved');
    // cycle count is NOT touched on approval — stays as-is in the DB.
    expect(patchBody.quality_review_cycle_count).toBeUndefined();
    // Owner push fires ONCE (for approved only).
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(true);
    // No correction WA for an approved outcome.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
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
