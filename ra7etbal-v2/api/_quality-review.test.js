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
  it('downloads proof images with cache bypass so corrected uploads at the same storage path are reviewed fresh', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from('fresh-salad-proof'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await downloadImageAsBase64({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      imagePath: 'task-images/user-1/task-1/proof/0.jpg',
    });

    expect(result).toBe(Buffer.from('fresh-salad-proof').toString('base64'));
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/task-images\/user-1\/task-1\/proof\/0\.jpg\?qi=/,
    );
    expect(options.cache).toBe('no-store');
    expect(options.headers['Cache-Control']).toBe('no-cache, no-store, max-age=0');
    expect(options.headers.Pragma).toBe('no-cache');
  });

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

  it('regression: a visually matching corrected proof is not fraud just because it resembles the reference', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"APPROVED","correction_message":null,"reasoning":"The salad bowl matches the requested result."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'make the salad bowl',
      delegationMessage: 'Please make the salad bowl like the photo.',
      referenceImageBase64: 'reference-salad-base64',
      proofImagesBase64: ['corrected-live-salad-base64'],
    });

    expect(result).toEqual({
      status: 'approved',
      note: 'The salad bowl matches the requested result.',
    });
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

  it('approves a correct item on a neutral surface for a find-item task', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"APPROVED","correction_message":null,"reasoning":"The correct Cheirosa 68 perfume mist is clearly visible in the live photo."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Find the Sol de Janeiro Cheirosa 68 perfume mist and send a photo.',
      delegationMessage: 'Grace, please find the perfume and send Sana a photo.',
      referenceImageBase64: 'cheirosa-68-reference-base64',
      proofImagesBase64: ['live-cheirosa-68-on-fabric-base64'],
    });

    expect(result).toEqual({
      status: 'approved',
      note: 'The correct Cheirosa 68 perfume mist is clearly visible in the live photo.',
    });
  });

  it('normalizes over-strict location rejection to approved when location proof was not explicitly required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"CORRECTION_REQUIRED","correction_message":"Grace, the perfume is photographed on fabric instead of inside the toilet cabinet. Please send a photo in the cabinet.","reasoning":"The item is visible but the location differs."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Find the Sol de Janeiro Cheirosa 68 perfume mist in the toilet cabinet and send a photo.',
      delegationMessage: 'Grace, please find the perfume in the toilet cabinet and send Sana a photo.',
      referenceImageBase64: 'cheirosa-68-reference-base64',
      proofImagesBase64: ['live-cheirosa-68-on-couch-base64'],
    });

    expect(result).toEqual({
      status: 'approved',
      note: 'Correct item is visible; location was not explicitly required.',
    });
  });

  it('still rejects a wrong item even when location is not required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"CORRECTION_REQUIRED","correction_message":"Grace, this is the wrong product. Please send a live photo of the Sol de Janeiro Cheirosa 68 perfume mist.","reasoning":"The visible bottle is a different product."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Find the Sol de Janeiro Cheirosa 68 perfume mist and send a photo.',
      delegationMessage: 'Grace, please find the perfume and send Sana a photo.',
      referenceImageBase64: 'cheirosa-68-reference-base64',
      proofImagesBase64: ['wrong-product-base64'],
    });

    expect(result.status).toBe('correction_required');
    expect(result.note).toContain('wrong product');
  });

  it('rejects a correct item in the wrong location only when the task explicitly asks for location proof', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"CORRECTION_REQUIRED","correction_message":"Grace, the perfume is visible but it is not shown inside the cabinet. Please send a photo showing it inside the cabinet.","reasoning":"The required cabinet location is missing."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Show me the Sol de Janeiro Cheirosa 68 perfume mist inside the cabinet.',
      delegationMessage: 'Grace, please send proof that the perfume is inside the cabinet.',
      referenceImageBase64: 'cheirosa-68-reference-base64',
      proofImagesBase64: ['live-cheirosa-68-on-couch-base64'],
    });

    expect(result.status).toBe('correction_required');
    expect(result.note).toContain('inside the cabinet');
  });

  it('still rejects synthetic or screenshot proof as fraud_suspected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"FRAUD_SUSPECTED","correction_message":null,"reasoning":"This looks like a screenshot of a product listing, not a live photo of the item."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Find the Sol de Janeiro Cheirosa 68 perfume mist and send a photo.',
      delegationMessage: 'Grace, please find the perfume and send Sana a photo.',
      referenceImageBase64: 'cheirosa-68-reference-base64',
      proofImagesBase64: ['screenshot-proof-base64'],
    });

    expect(result.status).toBe('fraud_suspected');
    expect(result.note).toContain('screenshot');
  });

  it('preserves correction loop behavior for visible non-location problems', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"CORRECTION_REQUIRED","correction_message":"Grace, the photo is too cropped to show the product label. Please send a clearer photo of the full bottle.","reasoning":"The label is cropped out."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Find the Sol de Janeiro Cheirosa 68 perfume mist and send a photo.',
      delegationMessage: 'Grace, please find the perfume and send Sana a photo.',
      referenceImageBase64: 'cheirosa-68-reference-base64',
      proofImagesBase64: ['cropped-bottle-base64'],
    });

    expect(result.status).toBe('correction_required');
    expect(result.note).toContain('too cropped');
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

  it('normalizes a clearly wrong item classified as fraud into correction_required for worker correction', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"FRAUD_SUSPECTED","correction_message":null,"reasoning":"The proof shows a different item instead of the requested salad bowl."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'make the salad bowl',
      delegationMessage: 'Please make the salad bowl like the reference.',
      referenceImageBase64: 'reference-salad-base64',
      proofImagesBase64: ['wrong-live-item-base64'],
    });

    expect(result.status).toBe('correction_required');
    expect(result.note).toContain('different item');
    expect(result.note).toContain('Please upload a new photo');
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

  it('unknown quality result falls safe to uncertain and never auto-completes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse('{"result":"WRONG_PROOF","correction_message":"Wrong item.","reasoning":"Wrong item."}'),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImageBase64: 'ref-base64',
      proofImagesBase64: ['proof-base64'],
    });

    expect(result.status).toBe('uncertain');
    expect(result.status).not.toBe('approved');
  });

  it('returns fraud_suspected deterministically when the proof is the exact same uploaded image as the reference', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'look for this in the closet',
      delegationMessage: 'Please find this and confirm.',
      referenceImageBase64: 'ref-base64',
      proofImagesBase64: ['ref-base64'],
    });

    expect(result).toEqual({
      status: 'fraud_suspected',
      note: 'The proof photo is exactly the same uploaded image as the reference, not a new photo of the completed task.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('guards against unsupported model claims that a non-identical proof is pixel-for-pixel the reference', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"FRAUD_SUSPECTED","correction_message":null,"reasoning":"The proof photo is pixel-for-pixel identical to the reference image."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'make the salad bowl',
      delegationMessage: 'Please make the salad bowl like the reference.',
      referenceImageBase64: 'reference-salad-base64',
      proofImagesBase64: ['new-live-salad-proof-base64'],
    });

    expect(result).toEqual({
      status: 'approved',
      note: 'Proof matches the requested result; no deterministic duplicate was detected.',
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

  it('instructs the model that screenshots are FRAUD_SUSPECTED but reference-reuse claims are deterministic only', async () => {
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
    expect(promptText).toMatch(/exact byte-for-byte duplicate check/i);
    expect(promptText).toMatch(/Do NOT claim "pixel-for-pixel identical"/i);
    expect(promptText).toMatch(/A correct proof photo may look very similar to the reference/i);
    expect(promptText).not.toMatch(/reused as if it were new proof/i);
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

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/task-images\/user-1\/task-1\/proof\.jpg\?qi=/,
    );
    expect(options).toEqual(
      expect.objectContaining({
        cache: 'no-store',
        headers: expect.objectContaining({
          apikey: 'service-key',
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
        }),
      }),
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
