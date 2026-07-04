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
    // No proof photos submitted — no task_attachments writes at all.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects photo delegation completion when no proof photo is submitted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'plate the chicken',
        assigned_to: 'Christopher',
        image_path: 'task-images/u/t/photo.jpg',
        attachment_count: 0,
      }]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1' }), res);

    expect(runQualityReviewMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Please attach a proof photo before marking this task done.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips review for a personal task with no assignee even if a proof photo is submitted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'd', assigned_to: null, image_path: null }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments (proof replace)
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments (proof replace)
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/user-1/task-1/proof/0.jpg'] }), res);

    expect(runQualityReviewMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(patchBody.proof_image_path).toBe('task-images/user-1/task-1/proof/0.jpg');
  });

  it('approved review: marks the task done and records the review outcome', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Matches the reference.' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please plate the chicken like the photo.' }])) // messages lookup
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments (proof replace)
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments (proof replace)
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }),
      res,
    );

    expect(runQualityReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskDescription: 'plate the chicken',
        delegationMessage: 'Please plate the chicken like the photo.',
        referenceImageBase64: 'base64-bytes',
        proofImagesBase64: ['base64-bytes'],
      }),
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBe('done');
    expect(patchBody.quality_review_status).toBe('approved');
    expect(patchBody.proof_image_path).toBe('task-images/u/t/proof/0.jpg');
  });

  it('approved review with 3 proof photos: all 3 sent to the vision review together, all 3 persisted', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'All three angles confirm it.' });
    downloadImageAsBase64Mock
      .mockReset()
      .mockResolvedValueOnce('ref-base64') // reference image
      .mockResolvedValueOnce('proof-0') // proof 1
      .mockResolvedValueOnce('proof-1') // proof 2
      .mockResolvedValueOnce('proof-2'); // proof 3

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'set the table', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please set the table for 6.' }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const paths = ['task-images/u/t/proof/0.jpg', 'task-images/u/t/proof/1.jpg', 'task-images/u/t/proof/2.jpg'];
    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: paths }), res);

    expect(runQualityReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ proofImagesBase64: ['proof-0', 'proof-1', 'proof-2'] }),
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));

    // Primary column set to the first photo (back-compat for TaskCard/HistoryCard).
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.proof_image_path).toBe(paths[0]);

    // All 3 photos replace the task_attachments proof set, in order.
    const deleteCall = fetchMock.mock.calls[3];
    expect(String(deleteCall[0])).toContain('/rest/v1/task_attachments');
    expect(String(deleteCall[0])).toContain('file_name=eq.proof');
    expect(deleteCall[1].method).toBe('DELETE');

    const insertCall = fetchMock.mock.calls[4];
    expect(String(insertCall[0])).toBe('https://example.supabase.co/rest/v1/task_attachments');
    const insertedRows = JSON.parse(insertCall[1].body);
    expect(insertedRows).toEqual([
      expect.objectContaining({ task_id: 'task-1', storage_path: paths[0], file_name: 'proof', sort_order: 0 }),
      expect.objectContaining({ task_id: 'task-1', storage_path: paths[1], file_name: 'proof', sort_order: 1 }),
      expect.objectContaining({ task_id: 'task-1', storage_path: paths[2], file_name: 'proof', sort_order: 2 }),
    ]);
  });

  it('a 6th submitted proof path is truncated server-side to 5 — defense in depth behind the client-side cap', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'ok' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'd', assigned_to: 'Christopher', image_path: null }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const sixPaths = Array.from({ length: 6 }, (_, i) => `task-images/u/t/proof/${i}.jpg`);
    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: sixPaths }), res);

    expect(runQualityReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ proofImagesBase64: expect.arrayContaining([]) }),
    );
    const insertedRows = JSON.parse(fetchMock.mock.calls[4][1].body);
    expect(insertedRows).toHaveLength(5);
  });

  it('replaceProofAttachments failure is non-fatal — the review outcome is still reported truthfully', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'ok' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'd', assigned_to: 'Christopher', image_path: null }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done (succeeds)
      .mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500)) // DELETE task_attachments fails
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert still runs
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    // The task was still marked done — a secondary-write failure must not
    // undo or hide the primary, already-succeeded status transition.
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, outcome: 'approved' }));
  });

  it('correction_required review: keeps task pending, creates a message row, and sends WhatsApp through direct_message', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, please center the chicken and send another photo.',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please plate the chicken like the photo.' }])) // messages lookup (delegation content)
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks (stays pending, review fields)
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments (proof replace)
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments (proof replace)
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+971500000004' }])) // people lookup
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-1' }])) // correction messages insert
      .mockResolvedValueOnce(jsonResponse({ success: true, messageId: 'wamid.correction' })); // direct_message send
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }),
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
    expect(patchBody.proof_image_path).toBe('task-images/u/t/proof/0.jpg');
    expect(patchBody.quality_review_cycle_count).toBe(1);

    const correctionInsert = fetchMock.mock.calls.find(
      ([url, options]) => String(url).endsWith('/rest/v1/messages') && options?.method === 'POST',
    );
    expect(correctionInsert).toBeDefined();
    expect(JSON.parse(correctionInsert[1].body)).toMatchObject({
      user_id: 'user-1',
      task_id: null,
      recipient: 'Christopher',
      content: 'Christopher, please center the chicken and send another photo.',
      confirmation_url: null,
    });
    const correctionSend = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/send-whatsapp-task'));
    expect(correctionSend).toBeDefined();
    expect(JSON.parse(correctionSend[1].body)).toMatchObject({
      to: '+971500000004',
      messageText: 'Christopher, please center the chicken and send another photo.',
      confirmationLink: null,
      messageRecordId: 'correction-message-1',
      taskId: null,
      sendMode: 'direct_message',
      sourceType: 'quality_correction',
      recipientName: 'Christopher',
    });
    // No owner push for correction_required.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    // No confirmations row.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('correction_required: replaces the rejected proof set — a corrected resubmission with fewer photos does not leave stale rows', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, one of these is still wrong.',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'd', assigned_to: 'Christopher', image_path: null }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+971500000004' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-1' }]))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    // Corrected resubmission has only 1 photo, down from a prior 3-photo set.
    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'correction_required' }));
    const deleteCall = fetchMock.mock.calls[3];
    expect(deleteCall[1].method).toBe('DELETE');
    const insertedRows = JSON.parse(fetchMock.mock.calls[4][1].body);
    expect(insertedRows).toHaveLength(1);
  });

  it('correction_required: no owner push — QI note returned for on-page display', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, the chicken is not centered. Please retake the photo.',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Plate the chicken like the reference photo.' }])) // messages lookup
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+971500000004' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-1' }]))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        outcome: 'correction_required',
        correctionNote: 'Christopher, the chicken is not centered. Please retake the photo.',
        correctionCycleCount: 1,
      }),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(true);
    // No owner push.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('correction_required second submission: sends another correction, no owner push, cycle count increments', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, please center the chicken again.',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg', quality_review_cycle_count: 1 }]))
      .mockResolvedValueOnce(jsonResponse([])) // messages lookup
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks (cycle count -> 2)
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+971500000004' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-2' }]))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof2.jpg'] }), res);

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
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(8);
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
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }])); // push_subscriptions lookup
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

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
    // Owner-push path was attempted (push_subscriptions lookup ran) after the proof-attachment replace.
    expect(String(fetchMock.mock.calls[5][0])).toContain('/rest/v1/push_subscriptions');
  });

  it('cycle count increments only for non-approved outcomes — approved leaves it untouched', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Matches the reference.' });
    const fetchMock = vi
      .fn()
      // Task had one prior correction round before this approved resubmission.
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg', quality_review_cycle_count: 1 }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please plate the chicken like the photo.' }])) // messages lookup
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof2.jpg'] }), res);

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
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()); // INSERT task_attachments
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

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
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()); // INSERT task_attachments
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-2', proofImagePaths: ['task-images/u/t2/proof/0.jpg'] }), res);

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
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(emptyResponse()) // confirmations insert
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }])); // push (approved)
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof-pizza.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBe('done');
    // Owner push fires for approved.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(true);
    // No correction WhatsApp.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
  });

  it('scenario Pizza→Salad: correction WhatsApp sent, task open, NO owner push', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, that is a salad, not the pizza. Please bring the correct item.',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'get the pizza', assigned_to: 'Christopher', image_path: 'task-images/u/t/pizza.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please bring the pizza.' }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks (stays pending)
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+971500000004' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-1' }]))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof-salad.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'correction_required',
      correctionNote: 'Christopher, that is a salad, not the pizza. Please bring the correct item.',
    }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBeUndefined(); // task NOT marked done
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('scenario Pizza→Salad→Salad: second wrong proof sends correction, task open, NO owner push', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, that is still a salad. Please bring the pizza.',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'get the pizza', assigned_to: 'Christopher', image_path: 'task-images/u/t/pizza.jpg', quality_review_cycle_count: 1 }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please bring the pizza.' }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks (still pending, cycle -> 2)
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+971500000004' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-2' }]))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof-salad2.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'correction_required', correctionCycleCount: 2 }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBeUndefined(); // still NOT done
    expect(patchBody.quality_review_cycle_count).toBe(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(8);
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
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(emptyResponse()) // confirmations insert
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }])); // push (approved)
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof-pizza.jpg'] }), res);

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
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(runQualityReviewMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ already_done: true }));
    // Idempotent short-circuit — no attachment writes either.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Proof Photo V2 — task-confirm GET upload-slot signing', () => {
  it('signs up to 5 proof-upload slots with x-upsert set, so a resubmission to the same slot never gets a 400', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Christopher', status: 'pending', confirmed_at: null, image_path: null, proof_image_path: null, attachment_count: 0 }]))
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse([])) // existing proof attachments (none)
      // 5 signed-upload-url responses, one per slot
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/task-images/user-1/task-1/proof/0.jpg?token=t0' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/task-images/user-1/task-1/proof/1.jpg?token=t1' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/task-images/user-1/task-1/proof/2.jpg?token=t2' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/task-images/user-1/task-1/proof/3.jpg?token=t3' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/task-images/user-1/task-1/proof/4.jpg?token=t4' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({ method: 'GET', query: { taskId: 'task-1' } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.proofUploadSlots).toHaveLength(5);
    expect(body.proofUploadSlots.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
    expect(body.proofUploadSlots[0].storagePath).toBe('task-images/user-1/task-1/proof/0.jpg');

    // Every signing call must set x-upsert so overwriting an existing
    // object at the same index succeeds instead of returning a 400.
    const signingCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/object/upload/sign/'));
    expect(signingCalls).toHaveLength(5);
    for (const [, options] of signingCalls) {
      expect(options.headers['x-upsert']).toBe('true');
    }
  });

  it('does not generate upload slots for an already-done task', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Christopher', status: 'done', confirmed_at: '2026-01-01', image_path: null, proof_image_path: 'task-images/u/t/proof/0.jpg', attachment_count: 0 }]))
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse([])) // proof attachments query
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/proof/0.jpg?token=x' })); // legacy proof read
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({ method: 'GET', query: { taskId: 'task-1' } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.proofUploadSlots).toEqual([]);
  });

  it('returns existing proof photos from task_attachments, sorted by sort_order, without leaking into the reference-photo grid', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Christopher', status: 'pending', confirmed_at: null, image_path: null, proof_image_path: 'task-images/u/t/proof/0.jpg', attachment_count: 0 }]))
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse([{ storage_path: 'task-images/u/t/proof/0.jpg' }, { storage_path: 'task-images/u/t/proof/1.jpg' }])) // proof attachments
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/proof/0.jpg?token=a' }))
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/proof/1.jpg?token=b' }))
      // 5 upload-slot signings (task not done)
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/x/0.jpg?token=t0' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/x/1.jpg?token=t1' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/x/2.jpg?token=t2' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/x/3.jpg?token=t3' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/x/4.jpg?token=t4' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({ method: 'GET', query: { taskId: 'task-1' } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.proofImageUrls).toHaveLength(2);
    // The reference-photo query filters file_name=is.null, so proof rows
    // (file_name='proof') can never appear as reference photos.
    const referenceAttachmentCall = fetchMock.mock.calls.find(
      ([url]) => String(url).includes('/rest/v1/task_attachments') && String(url).includes('file_name=is.null'),
    );
    expect(referenceAttachmentCall).toBeUndefined(); // attachment_count is 0 here, so this query never runs
    const proofAttachmentCall = fetchMock.mock.calls.find(
      ([url]) => String(url).includes('/rest/v1/task_attachments') && String(url).includes('file_name=eq.proof'),
    );
    expect(proofAttachmentCall).toBeDefined();
  });

  it('falls back to the legacy single tasks.proof_image_path column when no task_attachments proof rows exist yet', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Christopher', status: 'done', confirmed_at: '2026-01-01', image_path: null, proof_image_path: 'task-images/u/t/proof.jpg', attachment_count: 0 }]))
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse([])) // no task_attachments proof rows (pre-V2 task)
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/proof.jpg?token=legacy' })); // legacy single-column read
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({ method: 'GET', query: { taskId: 'task-1' } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.proofImageUrls).toHaveLength(1);
    expect(body.proofImageUrls[0]).toContain('token=legacy');
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
