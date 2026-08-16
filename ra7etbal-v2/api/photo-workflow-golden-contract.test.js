/**
 * Golden regression contract — server-side half of the protected photo
 * workflow (production baseline commit 447a685). See
 * src/lib/photo-workflow-golden-contract.test.ts for the client-side half.
 *
 * Why this exists: the same production incident recurred repeatedly in one
 * day across this exact pipeline — a private note's photo leaked to staff
 * (PR #78), then a legitimate visual reference was silently dropped (PR
 * #79), then real WhatsApp media never sent for 2+ photos and proof photos
 * nearly leaked back to the assignee (PRs #80/#81), then a second reference
 * photo was dropped from Quality Intelligence review (PR #82). Each fix was
 * correct in isolation; the class of regression kept recurring because no
 * single suite locked the whole journey together. This file calls the real
 * production functions (api/send-whatsapp-task.js's handler, api/task-
 * confirm.js's handler, api/_quality-review.js's runQualityReview) with
 * only true I/O boundaries mocked (Supabase REST, the Meta Graph API, the
 * Anthropic API) — never source-text scans — so a future change that
 * breaks any of these scenarios fails CI on every PR via package.json's
 * test:carson-protected script, regardless of which file changed.
 *
 * Scenario labels match RA7ETBAL_STATE.md's protected-workflow note:
 *   A (server half) / G — 1 and 2 reference photos reach the real WhatsApp
 *     media-send payload (image-header template + freeform image messages)
 *   B — 2 references, 2 matching proofs, same order, approved
 *   C — 2 references, 2 matching proofs, reversed submission order, approved
 *   D — 2 references, 1 genuine mismatch, correction_required
 *   E — only 1 distinct proof for a 2-reference task is never silently
 *       treated as covering both, and the model's own correction_required
 *       verdict is never overridden to approved
 *   F — every reference photo appears in the quality-review model content
 *   J — proof attachments (file_name = 'proof') are excluded from the
 *       outbound reference-photo WhatsApp delivery
 *   K — a fresh proof submission clears and replaces prior review state
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '1234567890');
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
  vi.stubEnv('APP_BASE_URL', 'https://ra7etbal.com');
  vi.stubEnv('CRON_SECRET', 'cron-secret');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

// ── A (server half) / G / J — real WhatsApp media-send payload ─────────────
// Calls the real api/send-whatsapp-task.js handler with only the Meta Graph
// API and Supabase REST mocked at the fetch boundary.
describe('Golden contract [A-server/G/J] — WhatsApp media-send payload', () => {
  it('[G-1] single reference photo: the real Meta media_id reaches the image-header template payload', async () => {
    const { default: handler } = await import('./send-whatsapp-task.js');
    const fakeBuffer = new ArrayBuffer(1024);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1' }])) // task lookup
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }])) // whatsapp_deliveries insert
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/photo.jpg?token=abc' })) // signed url
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: vi.fn().mockResolvedValue(fakeBuffer) }) // Meta download
      .mockResolvedValueOnce(jsonResponse({ id: 'meta-media-id-golden' })) // Meta media upload
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.golden-single' }] })) // template send
      .mockResolvedValueOnce(emptyResponse()); // delivery update
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({
        to: '+971 50 000 0000',
        messageText: 'Make this for dinner.',
        confirmationLink: 'https://ra7etbal.com/confirm?task=task-1',
        taskId: 'task-1',
        imagePath: 'task-images/u/t/photo.jpg',
        attachmentCount: null,
        ownerName: 'Sana',
        recipientName: 'Christopher',
      }, { 'x-ra7etbal-internal-secret': 'cron-secret' }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const graphCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('graph.facebook.com/v20.0'));
    expect(graphCalls).toHaveLength(2); // media upload + template send
    const templatePayload = JSON.parse(graphCalls[1][1].body);
    expect(templatePayload.template.name).toBe('ra7etbal_task_image');
    const headerComponent = templatePayload.template.components.find((c) => c.type === 'header');
    expect(headerComponent.parameters[0].image).toEqual({ id: 'meta-media-id-golden' });
  });

  it('[G-2/J] two reference photos: both reach the WhatsApp payload as real freeform image messages, proof photos excluded from the query', async () => {
    const { default: handler } = await import('./send-whatsapp-task.js');
    const fakeBuffer = new ArrayBuffer(1024);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1' }])) // task lookup
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }])) // whatsapp_deliveries insert
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.golden-multi' }] })) // primary text template send
      .mockResolvedValueOnce(emptyResponse()) // delivery update
      // task_attachments lookup — must be filtered to file_name=is.null (J)
      .mockResolvedValueOnce(jsonResponse([
        { storage_path: 'task-images/u/t/attachments/0.jpg' },
        { storage_path: 'task-images/u/t/attachments/1.jpg' },
      ]))
      // photo 0: signed url, Meta download, Meta upload, freeform send
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/attachments/0.jpg?token=abc' }))
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: vi.fn().mockResolvedValue(fakeBuffer) })
      .mockResolvedValueOnce(jsonResponse({ id: 'meta-media-id-0' }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.photo0' }] }))
      // photo 1: signed url, Meta download, Meta upload, freeform send
      .mockResolvedValueOnce(jsonResponse({ signedURL: '/object/sign/task-images/u/t/attachments/1.jpg?token=abc' }))
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: vi.fn().mockResolvedValue(fakeBuffer) })
      .mockResolvedValueOnce(jsonResponse({ id: 'meta-media-id-1' }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.photo1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({
        to: '+971 50 000 0000',
        messageText: 'Make these for lunch.',
        confirmationLink: 'https://ra7etbal.com/confirm?task=task-1',
        taskId: 'task-1',
        imagePath: 'task-images/u/t/photo.jpg',
        attachmentCount: 2,
        ownerName: 'Sana',
        recipientName: 'Christopher',
      }, { 'x-ra7etbal-internal-secret': 'cron-secret' }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);

    // J — the attachments lookup must never return proof photos.
    const attachmentsLookupCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/rest/v1/task_attachments'));
    expect(String(attachmentsLookupCall[0])).toContain('file_name=is.null');

    // G-2 — both reference photos genuinely reach Meta as freeform image sends.
    const graphMessageCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url).includes('graph.facebook.com/v20.0') && String(url).endsWith('/messages'),
    );
    const imageSends = graphMessageCalls.map(([, init]) => JSON.parse(init.body)).filter((p) => p.type === 'image');
    expect(imageSends).toHaveLength(2);
    expect(imageSends.map((p) => p.image.id)).toEqual(['meta-media-id-0', 'meta-media-id-1']);

    const jsonCall = res.json.mock.calls.find((call) => call[0]?.mediaDeliveryResults);
    expect(jsonCall[0].mediaDeliveryResults.every((r) => r.sent)).toBe(true);
  });
});

// ── F — quality-review model content ────────────────────────────────────
// Calls the real runQualityReview with only the Anthropic API mocked.
describe('Golden contract [F] — every reference photo reaches the quality-review model content', () => {
  it('2 references + 2 proofs → 4 image blocks in the model content, references first, prompt states multiple photos with no positional pairing', async () => {
    const { runQualityReview } = await import('./_quality-review.js');
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse('{"result":"APPROVED","correction_message":null,"reasoning":"Both dishes match."}'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'make these for dinner, referring to the attached photos',
      delegationMessage: 'Make these for dinner.',
      referenceImagesBase64: ['ref-dish0', 'ref-dish1'],
      proofImagesBase64: ['proof-dish0', 'proof-dish1'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const images = body.messages[0].content.filter((b) => b.type === 'image');
    expect(images.map((img) => img.source.data)).toEqual(['ref-dish0', 'ref-dish1', 'proof-dish0', 'proof-dish1']);

    const promptText = body.messages[0].content.find((b) => b.type === 'text').text;
    expect(promptText).toMatch(/2 reference images/i);
    expect(promptText).toMatch(/2 proof photos/i);
    expect(promptText).toMatch(/do not assume any specific reference photo corresponds to any specific proof photo by position or order/i);
  });
});

// ── B, C, D, E, K — task-confirm.js orchestration ───────────────────────
// Calls the real api/task-confirm.js handler. api/_quality-review.js's two
// exports are mocked per-test via vi.doMock + vi.resetModules (never a
// top-level static vi.mock), so this file can freely mix "task-confirm.js
// with the review mocked" scenarios with the [F] scenario above that needs
// the real, unmocked _quality-review.js in the same run.
describe('Golden contract [B/C/D/E/K] — task-confirm.js quality-review orchestration', () => {
  let downloadImageAsBase64Mock;
  let runQualityReviewMock;
  let handler;

  beforeEach(async () => {
    downloadImageAsBase64Mock = vi.fn();
    runQualityReviewMock = vi.fn();
    vi.doMock('./_quality-review.js', () => ({
      downloadImageAsBase64: downloadImageAsBase64Mock,
      runQualityReview: runQualityReviewMock,
    }));
    ({ default: handler } = await import('./task-confirm.js'));
  });

  // vi.doMock registrations are not guaranteed to be cleared by
  // vi.resetModules() alone — explicitly unmock so the [F] describe block
  // above (real, unmocked _quality-review.js) is never affected by test
  // execution order within this file.
  afterEach(() => {
    vi.doUnmock('./_quality-review.js');
  });

  const REF0 = 'task-images/u/t/attachments/0.jpg';
  const REF1 = 'task-images/u/t/attachments/1.jpg';
  const PROOF0 = 'task-images/u/t/proof/0.jpg';
  const PROOF1 = 'task-images/u/t/proof/1.jpg';

  function byPath(map) {
    return ({ imagePath }) => Promise.resolve(map[imagePath] ?? null);
  }

  it('[B] 2 references, 2 matching proofs, submitted in the same order: both references loaded and passed to review, approved', async () => {
    downloadImageAsBase64Mock.mockImplementation(byPath({
      [REF0]: 'ref-dish0', [REF1]: 'ref-dish1', [PROOF0]: 'proof-dish0', [PROOF1]: 'proof-dish1',
    }));
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Both dishes match.' });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1', user_id: 'user-1', status: 'pending',
        description: 'make these for dinner, referring to the attached photos.',
        assigned_to: 'Christopher', image_path: REF0, attachment_count: 2,
        proof_image_path: null, quality_review_status: null, quality_review_cycle_count: 0,
      }]))
      .mockResolvedValueOnce(jsonResponse([{ storage_path: REF0 }, { storage_path: REF1 }])) // reference lookup
      .mockResolvedValueOnce(jsonResponse([{ content: 'Make these for dinner.' }])) // delegation message
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments (proof replace)
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments (proof replace)
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: [PROOF0, PROOF1] }), res);

    expect(runQualityReviewMock).toHaveBeenCalledWith(expect.objectContaining({
      referenceImagesBase64: ['ref-dish0', 'ref-dish1'],
      proofImagesBase64: ['proof-dish0', 'proof-dish1'],
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
  });

  it('[C] 2 references, 2 matching proofs, submitted in reversed order: still approved — code does not reorder or reject on submission order', async () => {
    downloadImageAsBase64Mock.mockImplementation(byPath({
      [REF0]: 'ref-dish0', [REF1]: 'ref-dish1', [PROOF0]: 'proof-dish0', [PROOF1]: 'proof-dish1',
    }));
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'Both dishes match regardless of order.' });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1', user_id: 'user-1', status: 'pending',
        description: 'make these for dinner, referring to the attached photos.',
        assigned_to: 'Christopher', image_path: REF0, attachment_count: 2,
        proof_image_path: null, quality_review_status: null, quality_review_cycle_count: 0,
      }]))
      .mockResolvedValueOnce(jsonResponse([{ storage_path: REF0 }, { storage_path: REF1 }])) // reference lookup — always sort_order.asc
      .mockResolvedValueOnce(jsonResponse([{ content: 'Make these for dinner.' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    // Proofs submitted in the REVERSE order relative to the reference set.
    await handler(createReq({ taskId: 'task-1', proofImagePaths: [PROOF1, PROOF0] }), res);

    expect(runQualityReviewMock).toHaveBeenCalledWith(expect.objectContaining({
      referenceImagesBase64: ['ref-dish0', 'ref-dish1'],
      proofImagesBase64: ['proof-dish1', 'proof-dish0'],
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
  });

  it('[D] 2 references, 1 genuine mismatch: correction_required, task stays open, no confirmation recorded', async () => {
    downloadImageAsBase64Mock.mockImplementation(byPath({
      [REF0]: 'ref-dish0', [REF1]: 'ref-dish1', [PROOF0]: 'proof-dish0', [PROOF1]: 'proof-wrong-dish',
    }));
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, the second dish does not match the reference. Please remake it.',
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1', user_id: 'user-1', status: 'pending',
        description: 'make these for dinner, referring to the attached photos.',
        assigned_to: 'Christopher', image_path: REF0, attachment_count: 2,
        proof_image_path: null, quality_review_status: null, quality_review_cycle_count: 0,
      }]))
      .mockResolvedValueOnce(jsonResponse([{ storage_path: REF0 }, { storage_path: REF1 }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Make these for dinner.' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }])) // PATCH tasks (save_review)
      .mockResolvedValue(emptyResponse()); // best-effort follow-ups (proof attachment replace, correction WhatsApp) — non-fatal by design, mocked as succeeding so the test stays focused on the review outcome itself
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: [PROOF0, PROOF1] }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'correction_required' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(patchBody.quality_review_status).toBe('correction_required');
    expect(patchBody.status).not.toBe('done');
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/confirmations')),
    ).toBe(false);
  });

  it('[E] only 1 distinct proof submitted for a 2-reference task: the model sees the true count (1, not 2), and its correction_required verdict is never overridden to approved', async () => {
    downloadImageAsBase64Mock.mockImplementation(byPath({
      [REF0]: 'ref-dish0', [REF1]: 'ref-dish1', [PROOF0]: 'proof-dish0',
    }));
    // Represents the model correctly noticing only one of the two required
    // dishes was proven — this is the model's own judgment call; the golden
    // contract here is that our code faithfully reports the true photo
    // count and never second-guesses a genuine correction_required verdict.
    runQualityReviewMock.mockResolvedValue({
      status: 'correction_required',
      note: 'Christopher, only one dish was submitted — please also send proof of the second dish.',
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1', user_id: 'user-1', status: 'pending',
        description: 'make these for dinner, referring to the attached photos.',
        assigned_to: 'Christopher', image_path: REF0, attachment_count: 2,
        proof_image_path: null, quality_review_status: null, quality_review_cycle_count: 0,
      }]))
      .mockResolvedValueOnce(jsonResponse([{ storage_path: REF0 }, { storage_path: REF1 }]))
      .mockResolvedValueOnce(jsonResponse([{ content: 'Make these for dinner.' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }])) // PATCH tasks (save_review)
      .mockResolvedValue(emptyResponse()); // best-effort follow-ups (proof attachment replace, correction WhatsApp) — non-fatal by design, mocked as succeeding so the test stays focused on the review outcome itself
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: [PROOF0] }), res);

    // Duplicate images cannot be silently substituted for the missing one —
    // exactly 1 proof image reaches the model, matching what was submitted.
    expect(runQualityReviewMock).toHaveBeenCalledWith(expect.objectContaining({
      referenceImagesBase64: ['ref-dish0', 'ref-dish1'],
      proofImagesBase64: ['proof-dish0'],
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'correction_required' }));
    const patchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(patchBody.status).not.toBe('done');
  });

  it('[K] a fresh proof submission clears the prior review state before running a new review, and the final state reflects only the new outcome', async () => {
    downloadImageAsBase64Mock.mockResolvedValue('base64-bytes');
    runQualityReviewMock.mockResolvedValue({ status: 'approved', note: 'The new proof matches.' });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1', user_id: 'user-1', status: 'pending',
        description: 'plate the chicken like the reference',
        assigned_to: 'Christopher', image_path: 'task-images/u/t/photo.jpg', attachment_count: 0,
        proof_image_path: 'task-images/u/t/old-proof.jpg',
        // A prior review already flagged this task — this must be cleared,
        // not merged with the new outcome.
        quality_review_status: 'correction_required',
        quality_review_note: 'Old, stale correction note.',
        quality_review_cycle_count: 1,
      }]))
      .mockResolvedValueOnce(emptyResponse()) // clear_previous_review PATCH
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please plate the chicken.' }])) // delegation message
      .mockResolvedValueOnce(emptyResponse()) // PATCH tasks -> done
      .mockResolvedValueOnce(emptyResponse()) // DELETE task_attachments (proof replace)
      .mockResolvedValueOnce(emptyResponse()) // INSERT task_attachments (proof replace)
      .mockResolvedValueOnce(emptyResponse()); // confirmations insert
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/new-proof.jpg'] }),
      res,
    );

    // The clear happens before the new review — a real PATCH nulling every
    // stale review field, not a partial/merged update.
    const clearCall = fetchMock.mock.calls[1];
    expect(clearCall[1].method).toBe('PATCH');
    const clearBody = JSON.parse(clearCall[1].body);
    expect(clearBody.quality_review_status).toBeNull();
    expect(clearBody.quality_review_note).toBeNull();
    expect(clearBody.quality_reviewed_at).toBeNull();

    // The final persisted state reflects only the new outcome.
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    const finalPatchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(finalPatchBody.quality_review_status).toBe('approved');
    expect(finalPatchBody.quality_review_note).toBe('The new proof matches.');
    expect(finalPatchBody.quality_review_note).not.toContain('stale');
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

function anthropicResponse(text) {
  return {
    ok: true,
    json: async () => ({ content: [{ text }] }),
  };
}
