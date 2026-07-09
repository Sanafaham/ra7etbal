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

  it('production fix (2026-07-10): a proof that is the exact same uploaded image as the reference is judged by the model, not auto-rejected', async () => {
    // Was: a deterministic byte-for-byte check auto-classified this as
    // fraud_suspected before the model ever saw the images. Production bug:
    // this rejected a bowl task where the correct state genuinely matched
    // the reference. QI V1 now has no deterministic duplicate check — every
    // proof, including an exact-duplicate one, goes to the model.
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse(
        '{"result":"APPROVED","correction_message":null,"reasoning":"The bowl matches the requested result."}',
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'confirm the bowl is on the shelf',
      delegationMessage: 'Please confirm the bowl is on the shelf.',
      referenceImageBase64: 'bowl-reference-base64',
      proofImagesBase64: ['bowl-reference-base64'],
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(result).toEqual({ status: 'approved', note: 'The bowl matches the requested result.' });
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
      note: 'Proof matches the requested result; identity or similarity to the reference is not a valid reason to reject.',
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

  it('instructs the model that screenshots are FRAUD_SUSPECTED but identity/similarity to the reference is never grounds for rejection', async () => {
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
    expect(promptText).toMatch(/Do NOT claim "pixel-for-pixel identical"/i);
    expect(promptText).toMatch(/Identity or similarity to the reference is never evidence of anything on its own/i);
    expect(promptText).toMatch(/A correct proof photo may look very similar to, or exactly like, the reference/i);
    // Production fix (2026-07-10): the prompt no longer claims a
    // deterministic duplicate check exists, and no longer lists exact
    // reference reuse as valid FRAUD_SUSPECTED evidence.
    expect(promptText).not.toMatch(/exact byte-for-byte duplicate check/i);
    expect(promptText).not.toMatch(/reused as if it were new proof/i);
    expect(promptText).not.toMatch(/exact same reference image re-uploaded/i);
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

  describe('production fix: studio/polished/stock-looking proof is not grounds for rejection', () => {
    it('1. approves a correct pepperoni pizza proof even though the model notes it resembles the reference', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          anthropicResponse(
            '{"result":"APPROVED","correction_message":null,"reasoning":"The proof shows a pepperoni pizza matching the reference."}',
          ),
        ),
      );

      const result = await runQualityReview({
        apiKey: 'test-key',
        taskDescription: 'Ask Christopher to make this for lunch.',
        delegationMessage: 'Christopher, please make this pizza for lunch.',
        referenceImageBase64: 'pizza-reference-base64',
        proofImagesBase64: ['pepperoni-pizza-proof-base64'],
      });

      expect(result).toEqual({
        status: 'approved',
        note: 'The proof shows a pepperoni pizza matching the reference.',
      });
    });

    it('2. rejects a salad submitted for a pizza task', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          anthropicResponse(
            '{"result":"CORRECTION_REQUIRED","correction_message":"Christopher, this is a salad, not the pizza that was requested. Please make and photograph the pizza instead.","reasoning":"Wrong item — salad instead of pizza."}',
          ),
        ),
      );

      const result = await runQualityReview({
        apiKey: 'test-key',
        taskDescription: 'Ask Christopher to make this for lunch.',
        delegationMessage: 'Christopher, please make this pizza for lunch.',
        referenceImageBase64: 'pizza-reference-base64',
        proofImagesBase64: ['salad-proof-base64'],
      });

      expect(result.status).toBe('correction_required');
      expect(result.note).toContain('salad');
    });

    it('3. approves a correct product proof the model itself flags as studio-looking/polished', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          anthropicResponse(
            '{"result":"CORRECTION_REQUIRED","correction_message":"The correct TEREA Silver pack is shown, but the proof looks like a polished studio product photo rather than a live photo.","reasoning":"Studio-looking proof."}',
          ),
        ),
      );

      const result = await runQualityReview({
        apiKey: 'test-key',
        taskDescription: 'Buy a pack of TEREA Silver and send a photo.',
        delegationMessage: 'Please buy TEREA Silver and send a photo.',
        referenceImageBase64: 'terea-silver-reference-base64',
        proofImagesBase64: ['terea-silver-studio-proof-base64'],
      });

      expect(result).toEqual({
        status: 'approved',
        note: 'Proof shows the correct result; image style or polish is not a valid reason to reject.',
      });
    });

    it('4. rejects when the model cites only similar composition/style to the reference, nothing concrete', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          anthropicResponse(
            '{"result":"FRAUD_SUSPECTED","correction_message":null,"reasoning":"The composition and lighting are very similar to the reference image, which is suspicious."}',
          ),
        ),
      );

      const result = await runQualityReview({
        apiKey: 'test-key',
        taskDescription: 'Find the black blouse and send a photo.',
        delegationMessage: 'Please find the black blouse and send a photo.',
        referenceImageBase64: 'blouse-reference-base64',
        proofImagesBase64: ['blouse-proof-base64'],
      });

      expect(result.status).toBe('approved');
    });

    it('5. (superseded 2026-07-10) the exact same reference image re-uploaded as proof is judged by the model, not auto-rejected — see "same-reference/duplicate-image/live-proof suspicion" below', async () => {
      // This test previously asserted the opposite: a deterministic
      // byte-for-byte check auto-rejected exact-duplicate proofs as
      // fraud_suspected without ever calling the model. That behavior
      // itself caused a production false-positive rejection (a bowl task
      // where the correct state genuinely matched the reference) and was
      // reversed per explicit product decision. See the describe block
      // below for the full regression suite covering this reversal.
      const fetchMock = vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"APPROVED","correction_message":null,"reasoning":"The correct bracelet is shown, matching the reference."}',
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await runQualityReview({
        apiKey: 'test-key',
        taskDescription: 'Buy this bracelet and send a photo of it.',
        delegationMessage: 'Please buy this and send a photo.',
        referenceImageBase64: 'bracelet-reference-base64',
        proofImagesBase64: ['bracelet-reference-base64'],
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(result.status).toBe('approved');
    });

    it('6. instructs the model that AI-generated/stock-style images are valid references, not a reason to doubt the proof', async () => {
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
      const promptText = body.messages[0].content.find((block) => block.type === 'text').text;
      expect(promptText).toMatch(/AI-generated image, a stock\/web image/i);
      expect(promptText).toMatch(/does NOT have to look "live," casual, or amateur/i);
      expect(promptText).toMatch(/NEVER choose CORRECTION_REQUIRED or FRAUD_SUSPECTED only because the proof looks polished/i);
    });

    it('7. protected: a genuinely wrong/unrelated object is still rejected, not waved through by the style guard', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          anthropicResponse(
            '{"result":"CORRECTION_REQUIRED","correction_message":"Grace, this is a different, unrelated object, not the perfume that was requested. Please send a photo of the correct item.","reasoning":"Unrelated object."}',
          ),
        ),
      );

      const result = await runQualityReview({
        apiKey: 'test-key',
        taskDescription: 'Find the Sol de Janeiro Cheirosa 68 perfume mist and send a photo.',
        delegationMessage: 'Grace, please find the perfume and send Sana a photo.',
        referenceImageBase64: 'cheirosa-68-reference-base64',
        proofImagesBase64: ['unrelated-object-base64'],
      });

      expect(result.status).toBe('correction_required');
      expect(result.note).toContain('different, unrelated object');
    });

    it('wrong color/variant is still rejected when the exact variant matters, even if the proof looks polished', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          anthropicResponse(
            '{"result":"CORRECTION_REQUIRED","correction_message":"This is the wrong color — a white blouse instead of the requested black blouse. Please send the black one.","reasoning":"Wrong color variant."}',
          ),
        ),
      );

      const result = await runQualityReview({
        apiKey: 'test-key',
        taskDescription: 'Find the black blouse shown and send a photo.',
        delegationMessage: 'Please find the black blouse and send a photo.',
        referenceImageBase64: 'black-blouse-reference-base64',
        proofImagesBase64: ['white-blouse-proof-base64'],
      });

      expect(result.status).toBe('correction_required');
      expect(result.note).toContain('wrong color');
    });
  });

  describe('production fix (2026-07-10): same-reference/duplicate-image/live-proof suspicion is not grounds for rejection', () => {
    // Production bug: a reference bowl photo re-uploaded as proof (correct
    // outcome — the bowl genuinely hadn't changed) was auto-rejected as
    // fraud_suspected with "exactly the same uploaded image as the
    // reference" / "upload a new live proof photo", by a deterministic
    // byte-for-byte duplicate check that ran before the model ever saw the
    // images. An earlier pizza test (same pattern) had been approved before
    // that deterministic check was introduced (commit 765887a). QI V1
    // policy: approve when the proof matches the requested outcome; reject
    // only clear wrong outcomes. Same/similar/polished/internet-looking/
    // not-live/duplicate-image suspicion must never cause rejection.

    it('1. same reference/proof image with a matching requested outcome must approve', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"APPROVED","correction_message":null,"reasoning":"The bowl shown matches the requested item exactly."}',
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await runQualityReview({
        apiKey: 'test-key',
        taskDescription: 'confirm the bowl is on the shelf',
        delegationMessage: 'Please confirm the bowl is on the shelf and send a photo.',
        referenceImageBase64: 'bowl-reference-base64',
        proofImagesBase64: ['bowl-reference-base64'],
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(result.status).toBe('approved');
    });

    it('2. a polished or internet-looking matching food proof must approve', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          anthropicResponse(
            '{"result":"FRAUD_SUSPECTED","correction_message":null,"reasoning":"This looks like an internet-looking, polished photo rather than a casual live photo, even though the correct pizza is shown."}',
          ),
        ),
      );

      const result = await runQualityReview({
        apiKey: 'test-key',
        taskDescription: 'Ask Christopher to make this for lunch.',
        delegationMessage: 'Christopher, please make this pizza for lunch.',
        referenceImageBase64: 'pizza-reference-base64',
        proofImagesBase64: ['internet-looking-pizza-proof-base64'],
      });

      expect(result.status).toBe('approved');
    });

    it('3. a clear wrong food proof must still reject (asked for salad, proof is pizza)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          anthropicResponse(
            '{"result":"CORRECTION_REQUIRED","correction_message":"Christopher, this is a pizza, not the salad that was requested. Please make and photograph the salad instead.","reasoning":"Wrong item — pizza instead of salad."}',
          ),
        ),
      );

      const result = await runQualityReview({
        apiKey: 'test-key',
        taskDescription: 'Ask Christopher to make a salad for lunch.',
        delegationMessage: 'Christopher, please make a salad for lunch.',
        referenceImageBase64: 'salad-reference-base64',
        proofImagesBase64: ['pizza-proof-base64'],
      });

      expect(result.status).toBe('correction_required');
      expect(result.note).toContain('pizza');
    });

    // 4. "Existing correction WhatsApp still sends for clear wrong outcome"
    // is protected by api/task-confirm.test.js's
    // "correction_required review: keeps task pending, creates a message
    // row, and sends WhatsApp through direct_message" — task-confirm.js's
    // WhatsApp-sending logic is untouched by this fix (only this file's
    // classification logic changed), and that test mocks runQualityReview
    // directly, so it already proves the WhatsApp path is unaffected.
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
