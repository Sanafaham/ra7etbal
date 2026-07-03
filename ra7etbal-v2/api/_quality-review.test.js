import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadImageAsBase64, runQualityReview } from './_quality-review.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function anthropicResponse(text) {
  return {
    ok: true,
    json: async () => ({ content: [{ text }] }),
  };
}

describe('runQualityReview', () => {
  it('returns approved with reasoning when the model approves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"APPROVED","correction_message":null,"reasoning":"Matches the reference image."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'plate the chicken like the reference',
      delegationMessage: 'Please plate the chicken like the photo.',
      referenceImageBase64: 'ref-base64',
      proofImagesBase64: ['proof-base64'],
    });

    expect(result).toEqual({ status: 'approved', note: 'Matches the reference image.' });
  });

  it('returns correction_required with the model-generated correction text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"CORRECTION_REQUIRED","correction_message":"Christopher, the chicken is not centered like the reference. Please center it and send another photo.","reasoning":"Off-center placement."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'plate the chicken like the reference',
      delegationMessage: 'Please plate the chicken like the photo.',
      referenceImageBase64: 'ref-base64',
      proofImagesBase64: ['proof-base64'],
    });

    expect(result.status).toBe('correction_required');
    expect(result.note).toBe(
      'Christopher, the chicken is not centered like the reference. Please center it and send another photo.',
    );
  });

  it('falls back to uncertain when correction_required has no usable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse('{"result":"CORRECTION_REQUIRED","correction_message":null,"reasoning":"unclear"}'),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImageBase64: null,
      proofImagesBase64: ['proof-base64'],
    });

    expect(result.status).toBe('uncertain');
  });

  it('returns uncertain when the model itself is uncertain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse('{"result":"UNCERTAIN","correction_message":null,"reasoning":"Photo is too blurry to tell."}'),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: null,
      referenceImageBase64: null,
      proofImagesBase64: ['proof-base64'],
    });

    expect(result).toEqual({ status: 'uncertain', note: 'Photo is too blurry to tell.' });
  });

  it('returns fraud_suspected when the proof is a reused reference image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"FRAUD_SUSPECTED","correction_message":null,"reasoning":"This is the same image as the reference photo, not a new photo of the completed task."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'look for this in the closet',
      delegationMessage: 'Please find this and confirm.',
      referenceImageBase64: 'ref-base64',
      proofImagesBase64: ['ref-base64'],
    });

    expect(result).toEqual({
      status: 'fraud_suspected',
      note: 'This is the same image as the reference photo, not a new photo of the completed task.',
    });
  });

  it('returns fraud_suspected when the proof is a screenshot rather than a live photo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"FRAUD_SUSPECTED","correction_message":null,"reasoning":"This looks like a screenshot of an Amazon product listing, not a photo of the item."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'buy the pearl bracelet shown',
      delegationMessage: 'Please buy this and send a photo.',
      referenceImageBase64: 'ref-base64',
      proofImagesBase64: ['screenshot-base64'],
    });

    expect(result.status).toBe('fraud_suspected');
    expect(result.note).toBe('This looks like a screenshot of an Amazon product listing, not a photo of the item.');
  });

  it('returns fraud_suspected for proof that is clearly not a live photo (e.g. a menu screenshot)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"FRAUD_SUSPECTED","correction_message":null,"reasoning":"This is a menu screenshot, not a photo of a completed task."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'order dinner from the usual place',
      delegationMessage: null,
      referenceImageBase64: null,
      proofImagesBase64: ['menu-screenshot-base64'],
    });

    expect(result.status).toBe('fraud_suspected');
  });

  it('instructs the model that screenshots and reused reference images are FRAUD_SUSPECTED', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse('{"result":"APPROVED","correction_message":null,"reasoning":"ok"}'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImageBase64: null,
      proofImagesBase64: ['proof-base64'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const promptText = body.messages[0].content.find((block) => block.type === 'text').text;
    expect(promptText).toMatch(/FRAUD_SUSPECTED/);
    expect(promptText).toMatch(/screenshot/i);
    expect(promptText).toMatch(/reused as if it were new proof/i);
  });

  it('falls back to uncertain when the Anthropic API call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImageBase64: null,
      proofImagesBase64: ['proof-base64'],
    });

    expect(result.status).toBe('uncertain');
  });

  it('falls back to uncertain when the model output is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(anthropicResponse('Sure, here is my answer: looks fine!')));

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImageBase64: null,
      proofImagesBase64: ['proof-base64'],
    });

    expect(result.status).toBe('uncertain');
  });

  it('falls back to uncertain without calling the API when there is no proof image', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImageBase64: 'ref-base64',
      proofImagesBase64: [],
    });

    expect(result.status).toBe('uncertain');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to uncertain without calling the API when no API key is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runQualityReview({
      apiKey: undefined,
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImageBase64: null,
      proofImagesBase64: ['proof-base64'],
    });

    expect(result.status).toBe('uncertain');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends both images when a reference image is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse('{"result":"APPROVED","correction_message":null,"reasoning":"ok"}'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImageBase64: 'ref-base64',
      proofImagesBase64: ['proof-base64'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const images = body.messages[0].content.filter((block) => block.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0].source.data).toBe('ref-base64');
    expect(images[1].source.data).toBe('proof-base64');
  });

  it('instructs the model that a clearly wrong/mismatched item is CORRECTION_REQUIRED, not UNCERTAIN', async () => {
    // Regression guard: live tests showed the model inconsistently classified
    // an obviously wrong item (visible, describable mismatch) as UNCERTAIN
    // instead of CORRECTION_REQUIRED, which silently skipped notifying the
    // assignee (UNCERTAIN only pushes the owner — see task-confirm.js). The
    // prompt must explicitly steer the model away from that misclassification.
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse('{"result":"APPROVED","correction_message":null,"reasoning":"ok"}'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImageBase64: null,
      proofImagesBase64: ['proof-base64'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const promptText = body.messages[0].content.find((block) => block.type === 'text').text;
    expect(promptText).toMatch(/entirely different\/mismatched item/i);
    expect(promptText).toMatch(/is CORRECTION_REQUIRED, not UNCERTAIN/i);
    expect(promptText).toMatch(/never UNCERTAIN/i);
  });
});

describe('downloadImageAsBase64', () => {
  it('returns null when imagePath is missing', async () => {
    const result = await downloadImageAsBase64({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      imagePath: null,
    });
    expect(result).toBeNull();
  });

  it('strips the bucket prefix and returns base64 bytes on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('image-bytes').buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await downloadImageAsBase64({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      imagePath: 'task-images/user-1/task-1/proof.jpg',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/storage/v1/object/task-images/user-1/task-1/proof.jpg',
      expect.objectContaining({ headers: expect.objectContaining({ apikey: 'service-key' }) }),
    );
    expect(result).toBe(Buffer.from('image-bytes').toString('base64'));
  });

  it('returns null when the download fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const result = await downloadImageAsBase64({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      imagePath: 'task-images/user-1/task-1/proof.jpg',
    });

    expect(result).toBeNull();
  });
});
