import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import webpush from 'web-push';

const downloadImageAsBase64Mock = vi.fn();
const runQualityReviewMock = vi.fn();
const __dirname = dirname(fileURLToPath(import.meta.url));
const TASK_CONFIRM_SOURCE = readFileSync(join(__dirname, 'task-confirm.js'), 'utf-8');

vi.mock('./_quality-review.js', () => ({
  downloadImageAsBase64: downloadImageAsBase64Mock,
  runQualityReview: runQualityReviewMock,
}));

vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));

let handler;
let buildOwnerPushBody;

beforeEach(async () => {
  vi.resetModules();
  ({ default: handler, buildOwnerPushBody } = await import('./task-confirm.js'));
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

describe('Quality Intelligence owner push copy source of truth', () => {
  it('rejected QI proof uses flagged owner push copy', () => {
    const body = buildOwnerPushBody({
      description: 'make the salad bowl',
      assignedTo: 'Christopher',
      variant: 'correction_required',
    });

    expect(body).toContain("Carson flagged Christopher's proof");
    expect(body).not.toMatch(/confirmed|submitted proof for review|hasn't confirmed/i);
  });

  it('suspicious QI proof uses flagged owner push copy', () => {
    const body = buildOwnerPushBody({
      description: 'make the salad bowl',
      assignedTo: 'Christopher',
      variant: 'fraud_suspected',
    });

    expect(body).toContain("Carson flagged Christopher's proof");
    expect(body).not.toMatch(/confirmed|submitted proof for review|hasn't confirmed/i);
  });

  it('proof submitted for owner review does not use flagged or has-not-confirmed copy', () => {
    const body = buildOwnerPushBody({
      description: 'make the salad bowl',
      assignedTo: 'Christopher',
      variant: 'uncertain',
    });

    expect(body).toBe('Christopher submitted proof for review: make the salad bowl');
    expect(body).not.toMatch(/flagged|hasn't confirmed/i);
  });

  it('accepted QI proof and normal task confirmation use confirmation copy, not flagged copy', () => {
    const body = buildOwnerPushBody({
      description: 'make the salad bowl',
      assignedTo: 'Christopher',
    });

    expect(body).toBe('Christopher confirmed: make the salad bowl');
    expect(body).not.toMatch(/flagged|hasn't confirmed|submitted proof for review/i);
  });
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
    expect(
      fetchMock.mock.calls.some(
        ([url, options]) =>
          String(url).includes('/rest/v1/tasks') &&
          String(options?.method || '').toUpperCase() === 'DELETE',
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([url, options]) =>
          String(url).includes('/rest/v1/messages') &&
          String(options?.method || '').toUpperCase() === 'DELETE',
      ),
    ).toBe(false);
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

  it('regression: wrong pizza proof rejected, corrected salad proof accepted, stale correction state cannot carry forward', async () => {
    runQualityReviewMock
      .mockResolvedValueOnce({
        status: 'correction_required',
        note: 'Christopher, that is pizza, not the salad bowl. Please send the salad bowl.',
      })
      .mockResolvedValueOnce({ status: 'approved', note: 'Correct salad bowl confirmed.' });
    downloadImageAsBase64Mock
      .mockReset()
      .mockResolvedValueOnce('ref-salad') // first review reference
      .mockResolvedValueOnce('proof-pizza') // first review proof, wrong
      .mockResolvedValueOnce('ref-salad') // corrected review reference
      .mockResolvedValueOnce('proof-salad'); // corrected review proof, latest bytes

    const sameProofSlot = 'task-images/user-1/task-1/proof/0.jpg';
    const fetchMock = vi
      .fn()
      // First submission: pizza is rejected.
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'make the salad bowl',
        assigned_to: 'Christopher',
        image_path: 'task-images/user-1/task-1/reference-salad.jpg',
        attachment_count: 0,
        quality_review_cycle_count: 0,
      }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please make the salad bowl exactly like the photo.' }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> correction_required
      .mockResolvedValueOnce(emptyResponse()) // DELETE proof attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT proof attachments
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+971500000004' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-1' }]))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      // Second submission: same proof slot has been overwritten with salad and must be evaluated independently.
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'make the salad bowl',
        assigned_to: 'Christopher',
        image_path: 'task-images/user-1/task-1/reference-salad.jpg',
        attachment_count: 0,
        quality_review_cycle_count: 1,
        quality_review_status: 'correction_required',
        quality_review_note: 'Christopher, that is pizza, not the salad bowl. Please send the salad bowl.',
      }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> clear old correction before fresh review
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please make the salad bowl exactly like the photo.' }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done, approved
      .mockResolvedValueOnce(emptyResponse()) // DELETE proof attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT proof attachments
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const firstRes = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: [sameProofSlot] }), firstRes);
    expect(firstRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'correction_required', correctionCycleCount: 1 }),
    );
    const firstPatchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(firstPatchBody.status).toBeUndefined();
    expect(firstPatchBody.quality_review_status).toBe('correction_required');
    expect(firstPatchBody.quality_review_note).toContain('pizza');

    const secondRes = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: [sameProofSlot] }), secondRes);
    expect(secondRes.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const clearPatchBody = JSON.parse(fetchMock.mock.calls[9][1].body);
    expect(clearPatchBody).toEqual({
      proof_image_path: sameProofSlot,
      quality_review_status: null,
      quality_review_note: null,
      quality_reviewed_at: null,
    });
    expect(fetchMock.mock.calls[9][1].method).toBe('PATCH');
    expect(runQualityReviewMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ referenceImageBase64: 'ref-salad', proofImagesBase64: ['proof-pizza'] }),
    );
    expect(runQualityReviewMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ referenceImageBase64: 'ref-salad', proofImagesBase64: ['proof-salad'] }),
    );

    const secondPatchBody = JSON.parse(fetchMock.mock.calls[11][1].body);
    expect(secondPatchBody.status).toBe('done');
    expect(secondPatchBody.quality_review_status).toBe('approved');
    expect(secondPatchBody.quality_review_note).toBe('Correct salad bowl confirmed.');
    expect(secondPatchBody.quality_review_note).not.toContain('pizza');
    expect(secondPatchBody.proof_image_path).toBe(sameProofSlot);
    expect(secondPatchBody.quality_review_cycle_count).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(true);
  });

  it('protected: wrong proof followed by another wrong proof stays open and does not incorrectly complete', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, that still is not the salad bowl.',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'make the salad bowl',
        assigned_to: 'Christopher',
        image_path: 'task-images/user-1/task-1/reference-salad.jpg',
        attachment_count: 0,
        quality_review_cycle_count: 1,
        quality_review_status: 'correction_required',
        quality_review_note: 'Christopher, that was pizza.',
      }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> clear old correction before fresh review
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please make the salad bowl exactly like the photo.' }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> still correction_required
      .mockResolvedValueOnce(emptyResponse()) // DELETE proof attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT proof attachments
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+971500000004' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-2' }]))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/user-1/task-1/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'correction_required', correctionCycleCount: 2 }),
    );
    const clearPatchBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(clearPatchBody).toEqual({
      proof_image_path: 'task-images/user-1/task-1/proof/0.jpg',
      quality_review_status: null,
      quality_review_note: null,
      quality_reviewed_at: null,
    });
    const patchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(patchBody.status).toBeUndefined();
    expect(patchBody.quality_review_status).toBe('correction_required');
    expect(patchBody.quality_review_note).toBe('Christopher, that still is not the salad bowl.');
    expect(String(fetchMock.mock.calls[3][0])).toContain('&status=eq.pending');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
  });

  it('stale rejection state cannot overwrite a newer accepted proof', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'This slow rejection must not overwrite a task that already became done.',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'make the salad bowl',
        assigned_to: 'Christopher',
        image_path: 'task-images/user-1/task-1/reference-salad.jpg',
        attachment_count: 0,
        quality_review_cycle_count: 1,
        quality_review_status: 'correction_required',
        quality_review_note: 'Prior proof was wrong.',
      }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> clear old correction before fresh review
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please make the salad bowl exactly like the photo.' }]))
      .mockResolvedValueOnce(emptyResponse()) // pending-only PATCH would match zero rows if a newer request already completed
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+971500000004' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-stale' }]))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/user-1/task-1/proof/0.jpg'] }), res);

    const stalePatchUrl = String(fetchMock.mock.calls[3][0]);
    expect(stalePatchUrl).toContain('/rest/v1/tasks?id=eq.task-1');
    expect(stalePatchUrl).toContain('&status=eq.pending');
    const stalePatchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(stalePatchBody.quality_review_status).toBe('correction_required');
    expect(stalePatchBody.status).toBeUndefined();
  });

  it('protected: if clearing stale review state fails, the corrected proof is not reviewed against a poisoned state', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Should not run.' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'make the salad bowl',
        assigned_to: 'Christopher',
        image_path: 'task-images/user-1/task-1/reference-salad.jpg',
        attachment_count: 0,
        quality_review_cycle_count: 1,
        quality_review_status: 'correction_required',
        quality_review_note: 'Christopher, that was pizza.',
      }]))
      .mockResolvedValueOnce(jsonResponse({ message: 'clear failed' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/user-1/task-1/proof/0.jpg'] }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Could not start a fresh review. Please try again.' });
    expect(runQualityReviewMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it('lockdown: a corrected proof after prior owner-review state is reviewed fresh and latest approval wins', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'approved',
      note: 'Fresh salad proof approved after owner-review state.',
    });
    downloadImageAsBase64Mock
      .mockReset()
      .mockResolvedValueOnce('ref-salad')
      .mockResolvedValueOnce('fresh-salad-proof');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'make the salad bowl',
        assigned_to: 'Christopher',
        image_path: 'task-images/user-1/task-1/reference-salad.jpg',
        attachment_count: 0,
        quality_review_cycle_count: 1,
        quality_review_status: 'fraud_suspected',
        quality_review_note: 'The prior proof looked like a reused reference image.',
      }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> clear old owner-review warning before fresh review
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please make the salad bowl exactly like the photo.' }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done, approved
      .mockResolvedValueOnce(emptyResponse()) // DELETE proof attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT proof attachments
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/user-1/task-1/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const clearPatchBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(clearPatchBody).toEqual({
      proof_image_path: 'task-images/user-1/task-1/proof/0.jpg',
      quality_review_status: null,
      quality_review_note: null,
      quality_reviewed_at: null,
    });
    expect(runQualityReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImageBase64: 'ref-salad', proofImagesBase64: ['fresh-salad-proof'] }),
    );
    const approvedPatchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(approvedPatchBody.status).toBe('done');
    expect(approvedPatchBody.quality_review_status).toBe('approved');
    expect(approvedPatchBody.quality_review_note).toBe('Fresh salad proof approved after owner-review state.');
    expect(approvedPatchBody.quality_review_note).not.toContain('reused reference');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(true);
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
    const pushPayload = JSON.parse(vi.mocked(webpush.sendNotification).mock.calls[0][1]);
    expect(pushPayload.body).toContain('Grace submitted proof for review');
    expect(pushPayload.body).not.toMatch(/flagged|hasn't confirmed/i);
  });

  it('duplicate owner-review proof submit does not create a duplicate owner push', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'uncertain',
      note: 'This should not run for a duplicate owner-review submission.',
    });
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:owner@example.com');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'get the pizza',
        assigned_to: 'Christopher',
        image_path: 'task-images/u/t/pizza.jpg',
        proof_image_path: 'task-images/u/t/proof/0.jpg',
        quality_review_status: 'uncertain',
        quality_review_note: 'Owner already needs to review this proof.',
      }]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      outcome: 'uncertain',
      duplicate: true,
    }));
    expect(runQualityReviewMock).not.toHaveBeenCalled();
    expect(vi.mocked(webpush.sendNotification)).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('lockdown: an approved corrected proof cannot receive a staff correction follow-up', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Correct proof approved.' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'make the salad bowl',
        assigned_to: 'Christopher',
        image_path: 'task-images/u/t/photo.jpg',
        needs_follow_up: true,
        quality_review_cycle_count: 1,
        quality_review_status: 'correction_required',
        quality_review_note: 'Prior proof was wrong.',
      }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> clear old correction before fresh review
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please make the salad bowl.' }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const approvedPatchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(approvedPatchBody.status).toBe('done');
    expect(approvedPatchBody.quality_review_status).toBe('approved');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(false);
    const correctionMessageInserts = fetchMock.mock.calls.filter(
      ([url, options]) => String(url).endsWith('/rest/v1/messages') && options?.method === 'POST',
    );
    expect(correctionMessageInserts).toHaveLength(0);
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

  it('lockdown: reopening after an approved corrected proof returns final state and no upload slots', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        description: 'make the salad bowl',
        assigned_to: 'Christopher',
        status: 'done',
        confirmed_at: '2026-07-07T00:00:00.000Z',
        image_path: 'task-images/u/t/reference-salad.jpg',
        proof_image_path: 'task-images/u/t/proof/0.jpg',
        attachment_count: 0,
        quality_review_status: 'approved',
        quality_review_note: 'Correct salad bowl confirmed.',
      }]))
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse([{ storage_path: 'task-images/u/t/proof/0.jpg' }])) // proof attachments
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/reference-salad.jpg?token=reference' }))
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/proof/0.jpg?token=final' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({ method: 'GET', query: { taskId: 'task-1' } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('done');
    expect(body.qualityReviewStatus).toBe('approved');
    expect(body.qualityReviewNote).toBe('Correct salad bowl confirmed.');
    expect(body.proofUploadSlots).toEqual([]);
    expect(body.proofImageUrls).toEqual([
      'https://example.supabase.co/storage/v1/object/sign/task-images/u/t/proof/0.jpg?token=final',
    ]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/object/upload/sign/'))).toHaveLength(0);
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

  it('returns the persisted quality review status/note so a fresh page load can rehydrate the locked state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Christopher', status: 'pending',
            confirmed_at: null, image_path: null, proof_image_path: 'task-images/u/t/proof/0.jpg',
            attachment_count: 0, quality_review_status: 'uncertain', quality_review_note: 'No reference image to compare against.',
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse([{ storage_path: 'task-images/u/t/proof/0.jpg' }])) // proof attachments
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/proof/0.jpg?token=a' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({ method: 'GET', query: { taskId: 'task-1' } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.qualityReviewStatus).toBe('uncertain');
    expect(body.qualityReviewNote).toBe('No reference image to compare against.');
  });

  it('locks the confirmation link: no upload slots are generated once quality review is "uncertain"', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Christopher', status: 'pending',
            confirmed_at: null, image_path: null, proof_image_path: 'task-images/u/t/proof/0.jpg',
            attachment_count: 0, quality_review_status: 'uncertain', quality_review_note: 'No reference image to compare against.',
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse([{ storage_path: 'task-images/u/t/proof/0.jpg' }])) // proof attachments
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/proof/0.jpg?token=a' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({ method: 'GET', query: { taskId: 'task-1' } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.proofUploadSlots).toEqual([]);
    // No signing calls at all — locked tasks must not even attempt to sign upload URLs.
    const signingCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/object/upload/sign/'));
    expect(signingCalls).toHaveLength(0);
  });

  it('locks the confirmation link: no upload slots are generated once quality review is "fraud_suspected"', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Christopher', status: 'pending',
            confirmed_at: null, image_path: null, proof_image_path: 'task-images/u/t/proof/0.jpg',
            attachment_count: 0, quality_review_status: 'fraud_suspected', quality_review_note: 'This is the reference image, not a new photo.',
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse([{ storage_path: 'task-images/u/t/proof/0.jpg' }])) // proof attachments
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/proof/0.jpg?token=a' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({ method: 'GET', query: { taskId: 'task-1' } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.proofUploadSlots).toEqual([]);
  });

  it('protected: upload slots are still generated for "correction_required" — the recipient must still be able to resubmit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Christopher', status: 'pending',
            confirmed_at: null, image_path: null, proof_image_path: 'task-images/u/t/proof/0.jpg',
            attachment_count: 0, quality_review_status: 'correction_required', quality_review_note: 'Please center the chicken.',
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse([{ storage_path: 'task-images/u/t/proof/0.jpg' }])) // proof attachments
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/proof/0.jpg?token=a' }))
      // 5 upload-slot signings — still allowed
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/x/0.jpg?token=t0' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/x/1.jpg?token=t1' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/x/2.jpg?token=t2' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/x/3.jpg?token=t3' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/object/upload/sign/x/4.jpg?token=t4' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({ method: 'GET', query: { taskId: 'task-1' } }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.proofUploadSlots).toHaveLength(5);
    expect(body.qualityReviewStatus).toBe('correction_required');
  });
});

describe('Quality Intelligence safety lockdown — source-of-truth invariants', () => {
  it('POST loads quality review fields before deciding whether a fresh proof must clear stale state', () => {
    const postTaskSelectIdx = TASK_CONFIRM_SOURCE.indexOf(
      '&select=id,user_id,status,description,assigned_to,image_path,attachment_count,proof_image_path,quality_review_status,quality_review_note,quality_review_cycle_count',
    );
    const clearIdx = TASK_CONFIRM_SOURCE.indexOf('clearPreviousQualityReviewForFreshProof');
    const reviewIdx = TASK_CONFIRM_SOURCE.indexOf('review = await runQualityReview');
    expect(postTaskSelectIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(postTaskSelectIdx);
    expect(reviewIdx).toBeGreaterThan(clearIdx);
  });

  it('only one task-confirm POST path invokes the Quality Intelligence review', () => {
    expect(TASK_CONFIRM_SOURCE.match(/runQualityReview\(/g)).toHaveLength(1);
    expect(TASK_CONFIRM_SOURCE.match(/review = await runQualityReview/g)).toHaveLength(1);
  });

  it('there is a single fresh-proof clear helper and it clears all stale warning fields together', () => {
    expect(TASK_CONFIRM_SOURCE.match(/function clearPreviousQualityReviewForFreshProof/g)).toHaveLength(1);
    const helperBlock = TASK_CONFIRM_SOURCE.slice(
      TASK_CONFIRM_SOURCE.indexOf('async function clearPreviousQualityReviewForFreshProof'),
      TASK_CONFIRM_SOURCE.indexOf('\n}', TASK_CONFIRM_SOURCE.indexOf('async function clearPreviousQualityReviewForFreshProof')) + 2,
    );
    expect(helperBlock).toContain('proof_image_path: proofImagePath');
    expect(helperBlock).toContain('quality_review_status: null');
    expect(helperBlock).toContain('quality_review_note: null');
    expect(helperBlock).toContain('quality_reviewed_at: null');
  });

  it('non-approved QI review saves are pending-only so stale rejection cannot overwrite a completed task', () => {
    expect(TASK_CONFIRM_SOURCE).toContain(
      "supabaseUrl + '/rest/v1/tasks?id=eq.' + encodeURIComponent(taskId) + '&status=eq.pending'",
    );
  });

  it('GET exposes persisted review status as the confirmation page source of truth and locks owner-review states', () => {
    const getBlock = TASK_CONFIRM_SOURCE.slice(
      TASK_CONFIRM_SOURCE.indexOf('async function handleGet'),
      TASK_CONFIRM_SOURCE.indexOf('// ── POST: confirm the task'),
    );
    expect(getBlock).toContain("task.quality_review_status === 'uncertain' || task.quality_review_status === 'fraud_suspected'");
    expect(getBlock).toContain('task.status !== \'done\' && !isLockedForOwnerReview');
    expect(getBlock).toContain('qualityReviewStatus: task.quality_review_status ?? null');
    expect(getBlock).toContain('qualityReviewNote: task.quality_review_note ?? null');
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
