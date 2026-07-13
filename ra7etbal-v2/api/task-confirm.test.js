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

  it('repeated invalid proof escalation uses review copy, not first-failure flagged copy', () => {
    const body = buildOwnerPushBody({
      description: 'make the salad bowl',
      assignedTo: 'Christopher',
      variant: 'correction_limit',
    });

    expect(body).toContain("Christopher's proof");
    expect(body).toContain('still needs correction');
    expect(body).not.toMatch(/Carson flagged|confirmed|hasn't confirmed/i);
  });

  it('push notification copy maps to exactly one lifecycle variant', () => {
    const variants = [
      buildOwnerPushBody({ description: 'make the salad bowl', assignedTo: 'Christopher', variant: 'uncertain' }),
      buildOwnerPushBody({ description: 'make the salad bowl', assignedTo: 'Christopher', variant: 'correction_limit' }),
      buildOwnerPushBody({ description: 'make the salad bowl', assignedTo: 'Christopher' }),
    ];

    expect(variants[0]).toMatch(/submitted proof for review/i);
    expect(variants[0]).not.toMatch(/flagged|confirmed|hasn't confirmed/i);
    expect(variants[1]).toMatch(/still needs correction/i);
    expect(variants[1]).not.toMatch(/Carson flagged|confirmed|hasn't confirmed/i);
    expect(variants[2]).toMatch(/confirmed/i);
    expect(variants[2]).not.toMatch(/flagged|submitted proof for review|hasn't confirmed/i);
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
    // Regression (2026-07-08): approval must clear the follow-up guard and
    // bump updated_at, or the task can be left in a state a stale client
    // read as still "Waiting" even though it's done.
    expect(patchBody.needs_follow_up).toBe(false);
    expect(patchBody.updated_at).toBe(patchBody.confirmed_at);
    // No proof photos submitted — no task_attachments writes at all.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('normalizes a nested full confirmation URL in POST taskId before marking the task done', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'd', assigned_to: null, image_path: null }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'https://www.ra7etbal.com/confirm?task=task-1' }), res);

    expect(fetchMock.mock.calls[0][0]).toContain('/rest/v1/tasks?id=eq.task-1&');
    expect(fetchMock.mock.calls[1][0]).toContain('/rest/v1/tasks?id=eq.task-1&status=eq.pending');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, outcome: 'approved' }));
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
    // Regression (2026-07-08): a QI-approved task must also clear
    // needs_follow_up and bump updated_at — same as the no-review path.
    expect(patchBody.needs_follow_up).toBe(false);
    expect(patchBody.updated_at).toBe(patchBody.confirmed_at);
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

  it('first invalid proof does not send an owner flagged notification even when push is configured', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Grace, this is not the requested outfit. Please send a new photo.',
    });
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:owner@example.com');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'check the closet outfit', assigned_to: 'Grace', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please check if this outfit is in the closet.' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }])) // PATCH tasks -> correction_required
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ name: 'Grace', phone: '+971500000009' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-1' }]))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'correction_required' }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(vi.mocked(webpush.sendNotification)).not.toHaveBeenCalled();
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

  it('repeated invalid proofs escalate to owner review after the automated correction limit', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'fraud_suspected',
      note: 'This still looks like a screenshot, not a live completion photo.',
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
        description: 'check the closet outfit',
        assigned_to: 'Grace',
        image_path: 'task-images/u/t/photo.jpg',
        quality_review_cycle_count: 2,
      }]))
      .mockResolvedValueOnce(jsonResponse([])) // messages lookup
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> escalated owner review
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }])); // owner push
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof3.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        outcome: 'uncertain',
        correctionNote: null,
        correctionCycleCount: 3,
      }),
    );
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.status).toBeUndefined();
    expect(patchBody.quality_review_status).toBe('uncertain');
    expect(patchBody.quality_review_note).toContain('Multiple proof attempts still need owner review');
    expect(patchBody.quality_review_note).toContain('screenshot');
    expect(patchBody.quality_review_cycle_count).toBe(3);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(false);
    expect(String(fetchMock.mock.calls[5][0])).toContain('/rest/v1/push_subscriptions');
    const pushPayload = JSON.parse(vi.mocked(webpush.sendNotification).mock.calls.at(-1)[1]);
    expect(pushPayload.body).toContain("Grace's proof");
    expect(pushPayload.body).toContain('still needs correction');
    expect(pushPayload.body).not.toMatch(/Carson flagged|hasn't confirmed/i);
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
      worker_reply: null,
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
      worker_reply: null,
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
      worker_reply: null,
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

  it('Phase 8.1 — substitute_review: keeps the task pending, sends no correction WhatsApp, does not increment the cycle count, saves the worker reply, and pushes the owner', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'substitute_review',
      note: 'TEREA Silver was requested; the assignee sent TEREA Turquoise, a different variant.',
    });
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:owner@example.com');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1', user_id: 'user-1', status: 'pending', description: 'buy TEREA Silver',
        assigned_to: 'Ghulam', image_path: 'task-images/u/t/terea.jpg', quality_review_cycle_count: 2,
      }]))
      .mockResolvedValueOnce(jsonResponse([])) // no messages row
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({
        taskId: 'task-1',
        proofImagePaths: ['task-images/u/t/proof/0.jpg'],
        workerReply: 'Could not find TEREA Silver, found Turquoise instead.',
      }),
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, outcome: 'substitute_review' }),
    );
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.quality_review_status).toBe('substitute_review');
    expect(patchBody.worker_reply).toBe('Could not find TEREA Silver, found Turquoise instead.');
    // Narrow additive branch: does not consume the automated correction-attempt budget.
    expect(patchBody.quality_review_cycle_count).toBe(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
    const pushPayload = JSON.parse(vi.mocked(webpush.sendNotification).mock.calls[0][1]);
    expect(pushPayload.body).toContain('sent an alternative for review');
  });

  it('Phase 8.1 — worker reply is stored on an approved outcome too (never required, but not discarded)', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Matches the reference.' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'plate the chicken', assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please plate the chicken like the photo.' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof2.jpg'], workerReply: 'Found it in the garage.' }),
      res,
    );

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.worker_reply).toBe('Found it in the garage.');
  });

  it('Phase 8.1 — regression: a duplicate proof resubmission while substitute_review is pending is caught by the same guard as uncertain, protecting an in-flight owner decision', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'substitute_review',
      note: 'This should not run for a duplicate owner-review submission.',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'buy TEREA Silver',
        assigned_to: 'Ghulam',
        image_path: 'task-images/u/t/terea.jpg',
        proof_image_path: 'task-images/u/t/proof/0.jpg',
        quality_review_status: 'substitute_review',
        quality_review_note: 'TEREA Silver requested; Turquoise sent.',
      }]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      outcome: 'substitute_review',
      duplicate: true,
    }));
    // Never reaches a fresh review — the pending owner decision (whose lease
    // is keyed on quality_reviewed_at) must not be invalidated by a replay.
    expect(runQualityReviewMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('corrected valid proof sends only the completion owner notification, never stale flagged copy', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Correct outfit proof confirmed.' });
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:owner@example.com');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'check the closet outfit',
        assigned_to: 'Grace',
        image_path: 'task-images/u/t/photo.jpg',
        quality_review_cycle_count: 1,
        quality_review_status: 'correction_required',
        quality_review_note: 'Wrong proof.',
      }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> clear old correction before fresh review
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please check if this outfit is in the closet.' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', status: 'done' }])) // PATCH tasks -> approved
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(emptyResponse()) // confirmations insert
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    expect(vi.mocked(webpush.sendNotification)).toHaveBeenCalledTimes(1);
    const pushPayload = JSON.parse(vi.mocked(webpush.sendNotification).mock.calls[0][1]);
    expect(pushPayload.body).toBe('Grace confirmed: check the closet outfit');
    expect(pushPayload.body).not.toMatch(/Carson flagged|flagged|submitted proof for review|hasn't confirmed/i);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(false);
  });

  it('duplicate approved submit does not duplicate confirmations or owner notifications when pending guard matches zero rows', async () => {
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Correct proof confirmed.' });
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:owner@example.com');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'check the closet outfit',
        assigned_to: 'Grace',
        image_path: 'task-images/u/t/photo.jpg',
      }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please check if this outfit is in the closet.' }]))
      .mockResolvedValueOnce(jsonResponse([])); // PATCH tasks -> duplicate lost the pending race
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, already_done: true, outcome: 'approved', duplicate: true }),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(vi.mocked(webpush.sendNotification)).not.toHaveBeenCalled();
  });

  it('stale invalid review cannot send a flagged owner notification after a corrected proof already completed the task', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runQualityReviewMock.mockResolvedValue({
      status: 'fraud_suspected',
      note: 'This old request should not win after approval.',
    });
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:owner@example.com');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', description: 'check the closet outfit', assigned_to: 'Grace', image_path: 'task-images/u/t/photo.jpg' }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please check if this outfit is in the closet.' }]))
      .mockResolvedValueOnce(jsonResponse([])); // pending-only PATCH matched 0 rows because newer request completed first
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/old-proof.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, already_done: true, outcome: 'approved', stale: true }),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      '[task-confirm] stale non-approved review ignored after task left pending state',
      expect.objectContaining({ taskId: 'task-1', outcome: 'fraud_suspected' }),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
    expect(vi.mocked(webpush.sendNotification)).not.toHaveBeenCalled();
  });

  it('fraud_suspected review (reused reference image): keeps the task pending, asks the assignee for new proof, and does not notify the owner', async () => {
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
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ name: 'Grace', phone: '+971500000009' }])) // people lookup
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-1' }])) // correction messages insert
      .mockResolvedValueOnce(jsonResponse({ success: true, messageId: 'wamid.correction' })); // direct_message send
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        outcome: 'fraud_suspected',
        correctionNote: 'This is the same image as the reference photo, not a new photo of the completed task. Please upload a new live proof photo.',
      }),
    );
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.quality_review_status).toBe('fraud_suspected');
    expect(patchBody.status).toBeUndefined();
    const correctionSend = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/send-whatsapp-task'));
    expect(correctionSend).toBeDefined();
    expect(JSON.parse(correctionSend[1].body)).toMatchObject({
      to: '+971500000009',
      messageText: 'This is the same image as the reference photo, not a new photo of the completed task. Please upload a new live proof photo.',
      confirmationLink: null,
      sourceType: 'quality_correction',
      recipientName: 'Grace',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
  });

  it('fraud_suspected review (screenshot proof): same worker-correction routing as a reused reference image', async () => {
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
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ name: 'Grace', phone: '+971500000009' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'correction-message-1' }]))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-2', proofImagePaths: ['task-images/u/t2/proof/0.jpg'] }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        outcome: 'fraud_suspected',
        correctionNote: 'This looks like a screenshot of a product listing, not a photo of the item. Please upload a new live proof photo.',
      }),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-whatsapp-task'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
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

  it('QI review failure returns a useful proof-review error and does not save, confirm, or push', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runQualityReviewMock.mockRejectedValue(new Error('Anthropic request timed out'));
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:owner@example.com');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'check the outfit',
        assigned_to: 'Grace',
        image_path: 'task-images/u/t/outfit.jpg',
      }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please check if this outfit is in the closet.' }]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'The proof uploaded, but Carson could not review it. Please try again.',
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      '[task-confirm] proof confirmation failed',
      expect.objectContaining({ taskId: 'task-1', step: 'quality_review', proofCount: 1 }),
    );
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes('/rest/v1/tasks') && options?.method === 'PATCH')).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(vi.mocked(webpush.sendNotification)).not.toHaveBeenCalled();
  });

  it('DB review-save failure does not send owner push or confirmation after QI has reviewed the proof', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runQualityReviewMock.mockResolvedValue({
      status: 'uncertain',
      note: 'The proof is too dark to verify.',
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
        description: 'check the outfit',
        assigned_to: 'Grace',
        image_path: 'task-images/u/t/outfit.jpg',
      }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please check if this outfit is in the closet.' }]))
      .mockResolvedValueOnce(jsonResponse({ message: 'column quality_review_cycle_count does not exist' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'The proof uploaded, but Ra7etBal could not save the result. Please try again.',
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      '[task-confirm] save_review failed',
      expect.objectContaining({
        taskId: 'task-1',
        status: 400,
        body: expect.stringContaining('quality_review_cycle_count'),
        outcome: 'uncertain',
      }),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('push_subscriptions'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations'))).toBe(false);
    expect(vi.mocked(webpush.sendNotification)).not.toHaveBeenCalled();
  });

  it('owner push failure after a saved owner-review state does not break the proof submission response', async () => {
    runQualityReviewMock.mockResolvedValue({
      status: 'uncertain',
      note: 'Owner should review this proof.',
    });
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-public');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:owner@example.com');
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(new Error('push provider down'));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1',
        user_id: 'user-1',
        status: 'pending',
        description: 'check the outfit',
        assigned_to: 'Grace',
        image_path: 'task-images/u/t/outfit.jpg',
      }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please check if this outfit is in the closet.' }]))
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> owner review state saved
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments
      .mockResolvedValueOnce(jsonResponse([{ id: 'sub-1', endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, outcome: 'uncertain' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(patchBody.quality_review_status).toBe('uncertain');
    expect(vi.mocked(webpush.sendNotification)).toHaveBeenCalledTimes(1);
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
  it('normalizes a nested full confirmation URL in taskId before querying the task row', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Christopher', status: 'done', confirmed_at: '2026-01-01', image_path: null, proof_image_path: null, attachment_count: 0 }]))
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse([])); // proof attachments
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({ method: 'GET', query: { taskId: 'https://www.ra7etbal.com/confirm?task=task-1' } }, res);

    expect(fetchMock.mock.calls[0][0]).toContain('/rest/v1/tasks?id=eq.task-1&');
    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0]).toEqual(expect.objectContaining({ id: 'task-1' }));
  });

  it('normalizes an encoded nested confirmation URL in taskId before querying the task row', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Christopher', status: 'done', confirmed_at: '2026-01-01', image_path: null, proof_image_path: null, attachment_count: 0 }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({
      method: 'GET',
      query: { taskId: encodeURIComponent('https://www.ra7etbal.com/confirm?task=task-1') },
    }, res);

    expect(fetchMock.mock.calls[0][0]).toContain('/rest/v1/tasks?id=eq.task-1&');
    expect(res.status).not.toHaveBeenCalledWith(404);
  });

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

  it('Phase 8.1 — locks the confirmation link for substitute_review too: the owner decides next, not an automatic worker retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'task-1', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Ghulam', status: 'pending',
            confirmed_at: null, image_path: 'task-images/u/t/terea.jpg', proof_image_path: 'task-images/u/t/proof/0.jpg',
            attachment_count: 0, quality_review_status: 'substitute_review',
            quality_review_note: 'TEREA Silver requested; Turquoise sent.', worker_reply: 'Could not find Silver, found Turquoise instead.',
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
    expect(body.qualityReviewStatus).toBe('substitute_review');
    expect(body.workerReply).toBe('Could not find Silver, found Turquoise instead.');
    const signingCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/object/upload/sign/'));
    expect(signingCalls).toHaveLength(0);
  });

  it('protected: upload slots are still generated for "fraud_suspected" — Carson can collect a new live proof', async () => {
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
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/proof/0.jpg?token=a' }))
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
    expect(body.qualityReviewStatus).toBe('fraud_suspected');
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
  it('task-confirm has enough serverless time for the QI vision review timeout', () => {
    expect(TASK_CONFIRM_SOURCE).toContain('export const config = { maxDuration: 60 }');
    expect(TASK_CONFIRM_SOURCE).toContain("step = 'quality_review'");
    expect(TASK_CONFIRM_SOURCE).toContain('taskConfirmErrorMessageForStep(step)');
  });

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
    expect(TASK_CONFIRM_SOURCE).toContain("headers: { ...headers, Prefer: 'return=representation' }");
    expect(TASK_CONFIRM_SOURCE).toContain('stale non-approved review ignored after task left pending state');
    expect(TASK_CONFIRM_SOURCE).toContain('duplicate approval ignored after task left pending state');
  });

  it('GET exposes persisted review status as the confirmation page source of truth and locks only owner-review states', () => {
    const getBlock = TASK_CONFIRM_SOURCE.slice(
      TASK_CONFIRM_SOURCE.indexOf('async function handleGet'),
      TASK_CONFIRM_SOURCE.indexOf('// ── POST: confirm the task'),
    );
    expect(getBlock).toContain("task.quality_review_status === 'uncertain'");
    expect(getBlock).not.toContain("task.quality_review_status === 'uncertain' || task.quality_review_status === 'fraud_suspected'");
    expect(getBlock).toContain('task.status !== \'done\' && !isLockedForOwnerReview');
    expect(getBlock).toContain('qualityReviewStatus: task.quality_review_status ?? null');
    expect(getBlock).toContain('qualityReviewNote: task.quality_review_note ?? null');
  });

  it('Phase 8.1 — GET also locks for substitute_review (owner decides, not an automatic worker retry), but still not for correction_required/fraud_suspected', () => {
    const getBlock = TASK_CONFIRM_SOURCE.slice(
      TASK_CONFIRM_SOURCE.indexOf('async function handleGet'),
      TASK_CONFIRM_SOURCE.indexOf('// ── POST: confirm the task'),
    );
    expect(getBlock).toContain("task.quality_review_status === 'uncertain' || task.quality_review_status === 'substitute_review'");
    expect(getBlock).not.toContain("=== 'correction_required'");
    expect(getBlock).not.toContain("=== 'fraud_suspected'");
  });
});

describe('Phase 8.1 — PATCH owner decision (substitute_review)', () => {
  function patchReq(body, headers = { authorization: 'Bearer good-token' }) {
    return { method: 'PATCH', headers, body };
  }

  function metaAcceptedResponse(messageId = 'wamid.123') {
    return {
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ messages: [{ id: messageId }] })),
    };
  }

  beforeEach(() => {
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'meta-token');
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'phone-id');
  });

  it('rejects without an Authorization header', async () => {
    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative' }, {}), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects when the bearer token does not resolve to a user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false }));
    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative' }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects when the authenticated user does not own the task — prevents deciding someone else\'s task', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-999' })) // auth/v1/user
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1' }])); // task fetch
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects custom_instruction without instruction text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'user-1' })));
    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'custom_instruction' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('Approve Alternative accepted: sends exactly one WhatsApp message with an approval meaning, then completes through the shared custom_instruction pipeline — never completes with no message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' })) // auth/v1/user
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Ghulam', confirmation_url: null, quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: 'I only found turquoise' }])) // task fetch
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'approved_alternative' })) // claim RPC
      .mockResolvedValueOnce(jsonResponse([{ name: 'Ghulam', phone: '+15551234567' }])) // findAssigneePerson
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }])) // reserve_custom_instruction RPC (shared)
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }])) // fetchDeliveryStatus
      .mockResolvedValueOnce(emptyResponse()) // reserve_send_window RPC
      .mockResolvedValueOnce(metaAcceptedResponse()) // Meta send
      .mockResolvedValueOnce(emptyResponse()) // markMessageAccepted PATCH messages
      .mockResolvedValueOnce(emptyResponse()) // markWhatsappDeliveryAccepted PATCH whatsapp_deliveries
      .mockResolvedValueOnce(emptyResponse()); // complete_custom_instruction RPC
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, decision: 'approved_alternative', outcome: 'approved' }));
    const metaCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('graph.facebook.com'));
    expect(metaCalls).toHaveLength(1); // exactly one WhatsApp message
    const metaCallBody = JSON.parse(metaCalls[0][1].body);
    expect(metaCallBody.template.components[0].parameters[0].text).toMatch(/approved/i); // worker receives approval meaning
    // Completes through the shared pipeline, never the old no-message RPC.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/reserve_custom_instruction'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/complete_custom_instruction'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/complete_approved_alternative'))).toBe(false);
  });

  it('Approve Alternative immediate send failure: does not complete — task stays in Needs You, retry available, no duplicate message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Ghulam', confirmation_url: null, quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'approved_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Ghulam', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }])) // reserve_custom_instruction RPC
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse()) // reserve_send_window RPC
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'ecosystem engagement' } }, 400)) // Meta send rejects synchronously
      .mockResolvedValueOnce(emptyResponse()); // markWhatsappDeliveryFailed PATCH
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.status).toHaveBeenCalledWith(502);
    // Never reaches complete — the task's quality_review_status is untouched by this
    // request, so it stays exactly as substitute_review (still in Needs You).
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/complete_custom_instruction'))).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('graph.facebook.com'))).toHaveLength(1); // one attempt, no duplicate
  });

  it('Approve Alternative retry after the message was already accepted: skips the Meta send, does not duplicate the message, still completes exactly once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Ghulam', confirmation_url: null, quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'approved_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Ghulam', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }])) // reserve_custom_instruction — same message/delivery reused
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'accepted' }])) // fetchDeliveryStatus — already accepted from a prior attempt
      .mockResolvedValueOnce(emptyResponse()); // complete_custom_instruction RPC — goes straight here
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, decision: 'approved_alternative', outcome: 'approved' }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false); // no second send
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/reserve_send_window'))).toBe(false); // fence skipped too
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('Custom Instruction immediate send failure: does not complete — task stays in Needs You, retry available, no state loss', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Christopher', confirmation_url: null, quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'custom_instruction' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse()) // reserve_send_window
      .mockRejectedValueOnce(new Error('network down')); // Meta send throws
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'custom_instruction', instructionText: 'Ok get the Turquoise', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/complete_custom_instruction'))).toBe(false);
  });

  it('Reject Alternative: reserves, fences before send, sends one WhatsApp message, completes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' })) // auth/v1/user
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Christopher', confirmation_url: 'https://ra7etbal.com/confirm?task=task-1', quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }])) // task fetch
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'rejected_alternative' })) // claim RPC
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }])) // findAssigneePerson
      .mockResolvedValueOnce(jsonResponse([{ outcome: 'correction_required', message_id: 'msg-1', delivery_id: 'delivery-1' }])) // reserve_rejected_alternative RPC
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }])) // fetchDeliveryStatus
      .mockResolvedValueOnce(emptyResponse()) // reserve_send_window RPC
      .mockResolvedValueOnce(metaAcceptedResponse()) // Meta send
      .mockResolvedValueOnce(emptyResponse()) // markMessageAccepted PATCH messages
      .mockResolvedValueOnce(emptyResponse()) // markWhatsappDeliveryAccepted PATCH whatsapp_deliveries
      .mockResolvedValueOnce(emptyResponse()); // complete_rejected_alternative RPC
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'rejected_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, decision: 'rejected_alternative', outcome: 'correction_required' }));
    const metaCall = fetchMock.mock.calls.find(([url]) => String(url).includes('graph.facebook.com'));
    expect(metaCall).toBeDefined();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('graph.facebook.com'))).toHaveLength(1);
  });

  it('owner-decision template unset: keeps the old routine template with no button', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Christopher', confirmation_url: 'https://www.ra7etbal.com/confirm?task=task-1', quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'rejected_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ outcome: 'correction_required', message_id: 'msg-1', delivery_id: 'delivery-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(metaAcceptedResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'rejected_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    const metaCall = fetchMock.mock.calls.find(([url]) => String(url).includes('graph.facebook.com'));
    const metaPayload = JSON.parse(metaCall[1].body);
    expect(metaPayload.template.name).toBe('ra7etbal_routine_message');
    expect(metaPayload.template.components.every((component) => component.type !== 'button')).toBe(true);
  });

  it('owner-decision template set: uses a fresh task URL and only the task UUID as the button suffix', async () => {
    vi.stubEnv('WHATSAPP_OWNER_DECISION_TEMPLATE', 'ra7etbal_owner_decision');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: '3dbe480a-c4a0-4680-a5e0-921984a4c0ed', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Ghulam', confirmation_url: 'https://www.ra7etbal.com/confirm?task=stale-consumed-link', quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'approved_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Ghulam', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(metaAcceptedResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({
      taskId: encodeURIComponent('https://www.ra7etbal.com/confirm?task=task-1'),
      decision: 'approved_alternative',
      reviewedAt: '2026-07-10T00:00:00.000Z',
    }), res);

    expect(fetchMock.mock.calls[1][0]).toContain('/rest/v1/tasks?id=eq.task-1&');
    const metaCall = fetchMock.mock.calls.find(([url]) => String(url).includes('graph.facebook.com'));
    const metaPayload = JSON.parse(metaCall[1].body);
    const expectedMessage = 'Ghulam, the alternative for "buy TEREA Silver" was approved — please go ahead.';
    expect(metaPayload.template.name).toBe('ra7etbal_owner_decision');
    expect(metaPayload.template.components).toEqual([
      {
        type: 'body',
        parameters: [{ type: 'text', text: expectedMessage }],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: '3dbe480a-c4a0-4680-a5e0-921984a4c0ed' }],
      },
    ]);
    const buttonSuffix = metaPayload.template.components[1].parameters[0].text;
    expect(buttonSuffix).not.toContain(expectedMessage);
    expect(buttonSuffix).not.toContain('https://www.ra7etbal.com/confirm?task=');
    expect(`https://www.ra7etbal.com/confirm?task=${buttonSuffix}`).toBe(
      'https://www.ra7etbal.com/confirm?task=3dbe480a-c4a0-4680-a5e0-921984a4c0ed',
    );
    const reserveBody = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).includes('/rpc/reserve_custom_instruction'))[1].body);
    expect(reserveBody.p_confirmation_url).toBe('https://www.ra7etbal.com/confirm?task=3dbe480a-c4a0-4680-a5e0-921984a4c0ed');
  });

  it('owner-decision template set and stored confirmation_url missing: still sends the Utility template with a fresh Visit Task button', async () => {
    vi.stubEnv('WHATSAPP_OWNER_DECISION_TEMPLATE', 'ra7etbal_owner_decision');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: '8b7bd641-e67e-4bc5-9188-19f02e097b7b', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Ghulam', confirmation_url: null, quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'approved_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Ghulam', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(metaAcceptedResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    const metaPayload = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).includes('graph.facebook.com'))[1].body);
    expect(metaPayload.template.name).toBe('ra7etbal_owner_decision');
    expect(metaPayload.template.components.find((component) => component.type === 'button')?.parameters).toEqual([
      { type: 'text', text: '8b7bd641-e67e-4bc5-9188-19f02e097b7b' },
    ]);
  });

  it('Reject Alternative with owner-decision template set: uses the Utility template and preserves the task link button', async () => {
    vi.stubEnv('WHATSAPP_OWNER_DECISION_TEMPLATE', 'ra7etbal_owner_decision');
    const taskUuid = 'd7d760b4-106a-4f83-9ced-06e73c650e60';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: taskUuid, user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Christopher', confirmation_url: 'https://www.ra7etbal.com/confirm?task=8b7bd641-e67e-4bc5-9188-19f02e097b7b', quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'rejected_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ outcome: 'correction_required', message_id: 'msg-1', delivery_id: 'delivery-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(metaAcceptedResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: taskUuid, decision: 'rejected_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    const metaPayload = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).includes('graph.facebook.com'))[1].body);
    expect(metaPayload.template.name).toBe('ra7etbal_owner_decision');
    expect(metaPayload.template.components.find((component) => component.type === 'button')?.parameters).toEqual([
      { type: 'text', text: taskUuid },
    ]);
    const reserveBody = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).includes('/rpc/reserve_rejected_alternative'))[1].body);
    expect(reserveBody.p_confirmation_url).toBe(`https://www.ra7etbal.com/confirm?task=${taskUuid}`);
  });

  it('Custom Instruction with owner-decision template set: preserves exact owner wording and uses the Utility template button', async () => {
    vi.stubEnv('WHATSAPP_OWNER_DECISION_TEMPLATE', 'ra7etbal_owner_decision');
    const taskUuid = '6911e5e4-4515-43fb-8062-1a1824f59574';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: taskUuid, user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Christopher', confirmation_url: 'https://www.ra7etbal.com/confirm?task=stale-link', quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'custom_instruction' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(metaAcceptedResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: taskUuid, decision: 'custom_instruction', instructionText: 'Please get TEREA Turquoise exactly.', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    const metaPayload = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).includes('graph.facebook.com'))[1].body);
    expect(metaPayload.template.name).toBe('ra7etbal_owner_decision');
    expect(metaPayload.template.components[0].parameters[0].text).toBe('Please get TEREA Turquoise exactly.');
    expect(metaPayload.template.components.find((component) => component.type === 'button')?.parameters).toEqual([
      { type: 'text', text: taskUuid },
    ]);
    const reserveBody = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).includes('/rpc/reserve_custom_instruction'))[1].body);
    expect(reserveBody.p_confirmation_url).toBe(`https://www.ra7etbal.com/confirm?task=${taskUuid}`);
  });

  it('Custom Instruction: sends the owner\'s exact text, does not touch the correction cycle count', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Christopher', confirmation_url: null, quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'custom_instruction' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }])) // reserve_custom_instruction RPC
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse()) // reserve_send_window
      .mockResolvedValueOnce(metaAcceptedResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse()); // complete_custom_instruction RPC
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'custom_instruction', instructionText: 'Turquoise is fine, thanks!', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, decision: 'custom_instruction', outcome: 'custom_instruction_sent' }));
    const metaCallBody = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).includes('graph.facebook.com'))[1].body);
    expect(metaCallBody.template.components[0].parameters[0].text).toBe('Turquoise is fine, thanks!');
  });

  it('correction-limit fallback: no WhatsApp send when reserve resolves fallback_to_uncertain', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Christopher', confirmation_url: null, quality_review_status: 'substitute_review', quality_review_note: 'note', quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'rejected_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ outcome: 'fallback_to_uncertain', message_id: null, delivery_id: null }])); // reserve_rejected_alternative RPC — limit hit
    vi.stubGlobal('fetch', fetchMock);
    // VAPID left unset so sendOwnerPush short-circuits before any fetch.

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'rejected_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, decision: 'rejected_alternative', outcome: 'fallback_to_uncertain' }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('idempotent completed short-circuit: a completed decision is returned without any further RPC calls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Ghulam', confirmation_url: null, quality_review_status: 'approved', quality_review_note: null, quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-9', status: 'completed', decision: 'approved_alternative', outcome: 'approved' })); // claim RPC returns already-completed
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, outcome: 'approved', already_completed: true }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps a lease_lost RPC error to a 409 with a friendly retry message, never a silent success', async () => {
    // Fails at the claim step itself — decision-agnostic, and avoids modeling
    // the full reserve/send flow just to exercise generic RPC-error mapping.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Ghulam', confirmation_url: null, quality_review_status: 'substitute_review', quality_review_note: null, quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ message: 'lease_lost' }, 400)); // claim RPC fails — superseded lease
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/superseded/i) }));
  });

  it('Approve Alternative and Custom Instruction share the same completion RPC — the shared SQL never sets tasks.status or confirmed_at (source-level regression guard)', () => {
    const migrationSource = readFileSync(
      join(__dirname, '..', 'supabase', 'migrations', '20260712_approve_alternative_message_first.sql'),
      'utf-8',
    );
    const fnBody = migrationSource.slice(
      migrationSource.indexOf('CREATE OR REPLACE FUNCTION public.complete_custom_instruction'),
      migrationSource.indexOf('DROP FUNCTION IF EXISTS public.complete_approved_alternative'),
    );
    expect(fnBody).toContain("v_decision.decision NOT IN ('custom_instruction', 'approved_alternative')");
    expect(fnBody).toContain('quality_review_status = NULL, quality_review_note = NULL, quality_reviewed_at = NULL, worker_reply = NULL');
    expect(fnBody).not.toMatch(/status\s*=\s*'done'/);
    expect(fnBody).not.toMatch(/confirmed_at\s*=\s*now\(\)/);
    expect(fnBody).not.toMatch(/needs_follow_up\s*=\s*false/);
    // The old no-message completion path is dropped, not left reachable.
    expect(migrationSource).toContain('DROP FUNCTION IF EXISTS public.complete_approved_alternative(uuid, uuid, uuid);');
  });

  it('maps a decision_conflict RPC error to a 409 — never executes the second decision', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', description: 'd', assigned_to: 'Ghulam', confirmation_url: null, quality_review_status: 'substitute_review', quality_review_note: null, quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null }]))
      .mockResolvedValueOnce(jsonResponse({ message: 'decision_conflict' }, 400)); // claim RPC — a different decision already won
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'rejected_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
