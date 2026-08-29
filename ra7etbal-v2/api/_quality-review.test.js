import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadImageAsBase64, runQualityReview, fetchHouseholdRulesText, isAuthorizedProofPath } from './_quality-review.js';

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

describe('isAuthorizedProofPath (2026-08-29 supplemental security fix — proof-path scoping)', () => {
  const USER_ID = 'user-1';
  const TASK_ID = 'task-1';

  it('1. a valid path under the expected user/task/proof prefix -> PASS', () => {
    expect(isAuthorizedProofPath({ path: 'task-images/user-1/task-1/proof/0.jpg', userId: USER_ID, taskId: TASK_ID })).toBe(true);
    // Also valid without the bucket prefix, matching downloadImageAsBase64's own tolerance.
    expect(isAuthorizedProofPath({ path: 'user-1/task-1/proof/0.jpg', userId: USER_ID, taskId: TASK_ID })).toBe(true);
  });

  it("2. another user's path -> DENY", () => {
    expect(
      isAuthorizedProofPath({ path: 'task-images/someone-elses-user-id/task-1/proof/0.jpg', userId: USER_ID, taskId: TASK_ID }),
    ).toBe(false);
  });

  it('3. another task belonging to the SAME user -> DENY', () => {
    expect(
      isAuthorizedProofPath({ path: 'task-images/user-1/some-other-task-id/proof/0.jpg', userId: USER_ID, taskId: TASK_ID }),
    ).toBe(false);
  });

  it('4. an arbitrary unrelated object path -> DENY', () => {
    expect(isAuthorizedProofPath({ path: 'task-images/some/unrelated/object.jpg', userId: USER_ID, taskId: TASK_ID })).toBe(false);
    expect(isAuthorizedProofPath({ path: '', userId: USER_ID, taskId: TASK_ID })).toBe(false);
    expect(isAuthorizedProofPath({ path: null, userId: USER_ID, taskId: TASK_ID })).toBe(false);
  });

  it('5. malformed / traversal-style paths cannot bypass validation', () => {
    // Literal ".." after an otherwise-matching prefix.
    expect(
      isAuthorizedProofPath({ path: 'task-images/user-1/task-1/proof/../../someone-else/x.jpg', userId: USER_ID, taskId: TASK_ID }),
    ).toBe(false);
    // Percent-encoded ".." (decodes to a traversal segment).
    expect(
      isAuthorizedProofPath({
        path: 'task-images/user-1/task-1/proof/%2e%2e/%2e%2e/someone-else/x.jpg',
        userId: USER_ID,
        taskId: TASK_ID,
      }),
    ).toBe(false);
    // Malformed percent-encoding rejected outright rather than guessed at.
    expect(isAuthorizedProofPath({ path: 'task-images/user-1/task-1/proof/%', userId: USER_ID, taskId: TASK_ID })).toBe(false);
    // A prefix match with nothing meaningful after it is still rejected (no bare-folder reference).
    expect(isAuthorizedProofPath({ path: 'task-images/user-1/task-1/proof/', userId: USER_ID, taskId: TASK_ID })).toBe(false);
  });

  it('6/7. missing userId or taskId never authorizes any path, regardless of how plausible it looks', () => {
    expect(isAuthorizedProofPath({ path: 'task-images/user-1/task-1/proof/0.jpg', userId: null, taskId: TASK_ID })).toBe(false);
    expect(isAuthorizedProofPath({ path: 'task-images/user-1/task-1/proof/0.jpg', userId: USER_ID, taskId: null })).toBe(false);
  });
});

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
      referenceImagesBase64: ['ref-base64'],
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
      referenceImagesBase64: ['reference-salad-base64'],
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
      referenceImagesBase64: ['ref-base64'],
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
      referenceImagesBase64: ['cheirosa-68-reference-base64'],
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
      referenceImagesBase64: ['cheirosa-68-reference-base64'],
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
      referenceImagesBase64: ['cheirosa-68-reference-base64'],
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
      referenceImagesBase64: ['cheirosa-68-reference-base64'],
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
      referenceImagesBase64: ['cheirosa-68-reference-base64'],
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
      referenceImagesBase64: ['cheirosa-68-reference-base64'],
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
      referenceImagesBase64: [],
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
      referenceImagesBase64: ['reference-salad-base64'],
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
      referenceImagesBase64: [],
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
      referenceImagesBase64: ['ref-base64'],
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
      referenceImagesBase64: ['bowl-reference-base64'],
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
      referenceImagesBase64: ['reference-salad-base64'],
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
      referenceImagesBase64: ['ref-base64'],
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
      referenceImagesBase64: [],
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
      referenceImagesBase64: [],
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
      referenceImagesBase64: [],
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
      referenceImagesBase64: [],
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
      referenceImagesBase64: ['ref-base64'],
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
      referenceImagesBase64: [],
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
      referenceImagesBase64: ['ref-base64'],
      proofImagesBase64: ['proof-base64'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const images = body.messages[0].content.filter((block) => block.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0].source.data).toBe('ref-base64');
    expect(images[1].source.data).toBe('proof-base64');
  });

  // Regression (2026-07-26): confirmed production bug — a task with 2
  // reference photos only had the first sent to the model, so a proof photo
  // meant to match the second reference was judged against the wrong (only
  // available) reference and falsely flagged as CORRECTION_REQUIRED.
  it('sends all reference images and all proof images together — 2 references + 2 proofs = 4 image blocks, references first', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse('{"result":"APPROVED","correction_message":null,"reasoning":"Both dishes match."}'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'make these for dinner, referring to the attached photos',
      delegationMessage: 'Make these for dinner.',
      referenceImagesBase64: ['ref-salad-base64', 'ref-second-dish-base64'],
      proofImagesBase64: ['proof-salad-base64', 'proof-second-dish-base64'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const images = body.messages[0].content.filter((block) => block.type === 'image');
    expect(images).toHaveLength(4);
    expect(images.map((img) => img.source.data)).toEqual([
      'ref-salad-base64',
      'ref-second-dish-base64',
      'proof-salad-base64',
      'proof-second-dish-base64',
    ]);

    const promptText = body.messages[0].content.find((block) => block.type === 'text').text;
    expect(promptText).toMatch(/2 reference images/i);
    expect(promptText).toMatch(/2 proof photos/i);
    expect(promptText).toMatch(/do not assume any specific reference photo corresponds to any specific proof photo by position or order/i);
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
      referenceImagesBase64: [],
      proofImagesBase64: ['proof-base64'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const promptText = body.messages[0].content.find((block) => block.type === 'text').text;
    expect(promptText).toMatch(/entirely different\/mismatched item from a completely different product category/i);
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
        referenceImagesBase64: ['pizza-reference-base64'],
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
        referenceImagesBase64: ['pizza-reference-base64'],
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
        referenceImagesBase64: ['terea-silver-reference-base64'],
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
        referenceImagesBase64: ['blouse-reference-base64'],
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
        referenceImagesBase64: ['bracelet-reference-base64'],
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
        referenceImagesBase64: ['ref-base64'],
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
        referenceImagesBase64: ['cheirosa-68-reference-base64'],
        proofImagesBase64: ['unrelated-object-base64'],
      });

      expect(result.status).toBe('correction_required');
      expect(result.note).toContain('different, unrelated object');
    });

    it('correction_required from the model passes through unchanged — normalization does not reclassify it', async () => {
      // Note: the prompt now guides the model to return SUBSTITUTE_REVIEW for
      // same-category different-color/variant items (e.g. white pen for blue pen).
      // This test verifies only that if the model returns CORRECTION_REQUIRED,
      // normalizeReviewResult leaves it unchanged. The model's classification
      // behavior is covered by the substitute_review regression tests below.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          anthropicResponse(
            '{"result":"CORRECTION_REQUIRED","correction_message":"Christopher, this is a completely different item — IQOS sticks instead of the pen that was requested. Please go to the stationery store and buy a pen.","reasoning":"Unrelated product category."}',
          ),
        ),
      );

      const result = await runQualityReview({
        apiKey: 'test-key',
        taskDescription: 'Buy a blue pen from the stationery store.',
        delegationMessage: 'Please buy a blue pen and send a photo.',
        referenceImagesBase64: [],
        proofImagesBase64: ['iqos-sticks-proof-base64'],
      });

      expect(result.status).toBe('correction_required');
      expect(result.note).toContain('completely different item');
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
        referenceImagesBase64: ['bowl-reference-base64'],
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
        referenceImagesBase64: ['pizza-reference-base64'],
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
        referenceImagesBase64: ['salad-reference-base64'],
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

describe('Phase 8.1 — substitute_review (narrow additive branch)', () => {
  // Superseded by the Christopher substitution / alternative-selection
  // defect fix (owner product decision, this session): a worker's own note
  // is never sufficient authorization on its own — only a pre-existing
  // stored household rule is. This test now documents that corrected
  // behavior instead of the old (proven-wrong) one; the deterministic
  // downgrade lives in isSubstituteReviewUnauthorized in _quality-review.js.
  it('a worker note alone (no stored household rule) is NOT authorization — deterministically downgraded to correction_required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"SUBSTITUTE_REVIEW","correction_message":null,"reasoning":"TEREA Silver was requested but the assignee sent TEREA Turquoise, a different variant."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Buy a pack of TEREA Silver and send a photo.',
      delegationMessage: 'Please buy TEREA Silver and send a photo.',
      referenceImagesBase64: ['terea-silver-reference-base64'],
      proofImagesBase64: ['terea-turquoise-proof-base64'],
      workerReply: 'Could not find TEREA Silver, found Turquoise instead.',
      householdRulesText: null,
    });

    expect(result.status).toBe('correction_required');
  });

  it('a same-category substitute with a covering household rule stays authorized (not blindly downgraded) even with no worker note', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse(
        '{"result":"APPROVED","correction_message":null,"reasoning":"The stored rule permits this flower substitution."}',
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Buy the usual flowers and send a photo.',
      delegationMessage: null,
      referenceImagesBase64: ['flowers-reference-base64'],
      proofImagesBase64: ['different-flowers-proof-base64'],
      householdRulesText: 'Any in-season flower is an approved substitute for the usual flower order.',
    });

    expect(result.status).toBe('approved');
    // No workerReply was passed — must not appear as a note line in the prompt.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const promptText = body.messages[0].content.find((block) => block.type === 'text').text;
    expect(promptText).not.toMatch(/The assignee added this note/);
  });

  it('includes the worker reply as context in the prompt when present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse('{"result":"APPROVED","correction_message":null,"reasoning":"ok"}'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImagesBase64: [],
      proofImagesBase64: ['proof-base64'],
      workerReply: 'Could not find the exact item, sent a similar one.',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const promptText = body.messages[0].content.find((block) => block.type === 'text').text;
    expect(promptText).toContain('The assignee added this note when submitting proof');
    expect(promptText).toContain('Could not find the exact item, sent a similar one.');
  });

  it('normal variation (different plate/background/lighting/angle/portion) must never become substitute_review', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"APPROVED","correction_message":null,"reasoning":"Same dish, different plate and background — a normal home-made version of the reference."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'make the pasta like the reference photo',
      delegationMessage: 'Please make this pasta for dinner.',
      referenceImagesBase64: ['pasta-reference-base64'],
      proofImagesBase64: ['home-made-pasta-different-plate-base64'],
    });

    expect(result.status).toBe('approved');
    expect(result.status).not.toBe('substitute_review');
  });

  it('clearly wrong/unrelated outcome is still correction_required, never substitute_review', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"CORRECTION_REQUIRED","correction_message":"Christopher, this is a salad, not the pizza that was requested. Please make and photograph the pizza instead.","reasoning":"Wrong item — salad instead of pizza, not a reasonable substitute."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Ask Christopher to make this for lunch.',
      delegationMessage: 'Christopher, please make this pizza for lunch.',
      referenceImagesBase64: ['pizza-reference-base64'],
      proofImagesBase64: ['salad-proof-base64'],
    });

    expect(result.status).toBe('correction_required');
    expect(result.status).not.toBe('substitute_review');
  });

  // Superseded (Christopher substitution / alternative-selection defect fix,
  // this session): a same-category substitute with no prior owner
  // authorization is CORRECTION_REQUIRED by product decision, not an
  // automatic owner "Approve Alternative" decision — see the AUTHORIZATION
  // section this test's fix added to the prompt. The original 2026-08-02
  // fix this test protected (never silently reject a plausible substitute as
  // an unrelated wrong item) still holds — see the IQOS-sticks test below,
  // unaffected by this change — this test's own expected status is what
  // changed.
  it('regression (2026-08-02, superseded 2026-08-25): white pen for blue pen task with NO stored authorization is correction_required, not silently escalated as an owner decision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"SUBSTITUTE_REVIEW","correction_message":null,"reasoning":"A white pen was sent instead of the requested blue pen — same product category, different color."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Buy a blue pen from the stationery store.',
      delegationMessage: 'Please buy a blue pen and send a photo.',
      referenceImagesBase64: [],
      proofImagesBase64: ['white-pen-proof-base64'],
      householdRulesText: null,
    });

    expect(result.status).toBe('correction_required');
  });

  it('regression (2026-08-02): IQOS sticks for blue pen task is correction_required (unrelated product category)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"CORRECTION_REQUIRED","correction_message":"Christopher, this photo shows IQOS sticks, not the blue pen that was requested. Please go to the stationery store and buy a blue pen.","reasoning":"Completely different product category."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Buy a blue pen from the stationery store.',
      delegationMessage: 'Please buy a blue pen and send a photo.',
      referenceImagesBase64: [],
      proofImagesBase64: ['iqos-sticks-proof-base64'],
    });

    expect(result.status).toBe('correction_required');
    expect(result.note).toContain('IQOS');
  });

  // Superseded (Christopher substitution / alternative-selection defect fix,
  // this session) — see comment on the white-pen test above.
  it('regression (2026-08-02, superseded 2026-08-25): Pepsi for Coke task with NO stored authorization is correction_required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"SUBSTITUTE_REVIEW","correction_message":null,"reasoning":"Pepsi was sent instead of the requested Coke — same product category (cola), different brand."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Buy a can of Coke.',
      delegationMessage: 'Please buy a Coke and send a photo.',
      referenceImagesBase64: [],
      proofImagesBase64: ['pepsi-proof-base64'],
      householdRulesText: null,
    });

    expect(result.status).toBe('correction_required');
  });

  it('prompt explicitly states same-category different-color/variant defaults to CORRECTION_REQUIRED without stored authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse('{"result":"APPROVED","correction_message":null,"reasoning":"ok"}'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImagesBase64: [],
      proofImagesBase64: ['proof-base64'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const promptText = body.messages[0].content.find((block) => block.type === 'text').text;
    // Current rule: same-category different-attribute → CORRECTION_REQUIRED
    // by default, unless a stored household rule explicitly authorizes it.
    expect(promptText).toMatch(/a white pen when a blue pen was requested/i);
    expect(promptText).toMatch(/Pepsi when Coke was requested/i);
    expect(promptText).toMatch(/mushroom pizza when pepperoni was requested/i);
    expect(promptText).toMatch(/UNLESS stored household rules explicitly authorize that exact substitution/i);
  });

  it('prompt instructs the model on the exact 3-step decision order and narrow substitute_review boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse('{"result":"APPROVED","correction_message":null,"reasoning":"ok"}'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImagesBase64: [],
      proofImagesBase64: ['proof-base64'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const promptText = body.messages[0].content.find((block) => block.type === 'text').text;
    expect(promptText).toMatch(/check APPROVED first, then SUBSTITUTE_REVIEW, then CORRECTION_REQUIRED/i);
    expect(promptText).toMatch(/Do NOT use SUBSTITUTE_REVIEW for normal variation/i);
    expect(promptText).toMatch(/Do NOT use SUBSTITUTE_REVIEW for a completely wrong\/unrelated item/i);
    expect(promptText).toMatch(/"SUBSTITUTE_REVIEW"/);
    // Frozen: the existing four-outcome definitions are untouched substrings.
    expect(promptText).toContain(
      'APPROVED: the requested item/outcome is clearly correct, materially matches the task, and is a reasonable fulfillment of the request.',
    );
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

describe('fetchHouseholdRulesText', () => {
  it('returns the stored rules text for the user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ rules: 'Blueberries are an approved substitute for strawberries in any recipe.' }],
      }),
    );

    const result = await fetchHouseholdRulesText({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      userId: 'user-1',
    });

    expect(result).toBe('Blueberries are an approved substitute for strawberries in any recipe.');
  });

  it('returns null (fails closed to "no authority") when no row exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));

    const result = await fetchHouseholdRulesText({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      userId: 'user-1',
    });

    expect(result).toBeNull();
  });

  it('returns null (fails closed) on a network/API error, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await fetchHouseholdRulesText({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      userId: 'user-1',
    });

    expect(result).toBeNull();
  });

  it('returns null when userId is missing, without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchHouseholdRulesText({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      userId: null,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Christopher substitution / alternative-selection defect (owner-reported,
// traced to original July 15 product rule): a same-category/different-
// attribute proof submitted with NO prior owner authorization must default
// to CORRECTION_REQUIRED, not an owner "Approve Alternative" decision — the
// assignee acting first and explaining/asking afterward does not
// retroactively authorize it. The one recognized pre-existing authority is
// an explicit household rule that already covers this exact substitution
// (evaluated deterministically here — see `householdRulesText`), matching
// the timing rule that authorization must exist BEFORE the assignee acts.
// Per the owner's explicit architecture instruction, the classifier is not
// trusted on wording alone: a deterministic safety net (this file's
// established normalizeReviewResult pattern) downgrades a model-returned
// SUBSTITUTE_REVIEW to CORRECTION_REQUIRED whenever no household rules text
// exists at all for this user — in that case no authority could possibly
// exist, so the check requires no semantic judgment.
describe('Christopher substitution / alternative-selection defect — authorization-before-action', () => {
  it('1. DEFAULT: no household rules at all, model still returns SUBSTITUTE_REVIEW for a same-category/different-attribute item — deterministically downgraded to CORRECTION_REQUIRED, no owner decision created', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"SUBSTITUTE_REVIEW","correction_message":null,"reasoning":"Mushroom pizza submitted instead of the requested pepperoni pizza."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Ask Christopher to make a pepperoni pizza.',
      delegationMessage: 'Christopher, please make a pepperoni pizza.',
      referenceImagesBase64: [],
      proofImagesBase64: ['mushroom-pizza-proof-base64'],
      householdRulesText: null,
    });

    expect(result.status).toBe('correction_required');
    expect(result.note).toBeTruthy();
  });

  it('2. same as case 1 but householdRulesText is an empty string (row exists, no rules set) — still downgraded, empty text is still "no authority"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"SUBSTITUTE_REVIEW","correction_message":null,"reasoning":"Mushroom pizza submitted instead of pepperoni."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Ask Christopher to make a pepperoni pizza.',
      delegationMessage: 'Christopher, please make a pepperoni pizza.',
      proofImagesBase64: ['mushroom-pizza-proof-base64'],
      householdRulesText: '',
    });

    expect(result.status).toBe('correction_required');
  });

  it('3. EDGE CASE: assignee acted first and only asked afterward (workerReply carries the after-the-fact question) — still CORRECTION_REQUIRED; a later question never retroactively authorizes the earlier action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"SUBSTITUTE_REVIEW","correction_message":null,"reasoning":"Mushroom pizza submitted; assignee asks afterward if it is acceptable."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Ask Christopher to make a pepperoni pizza.',
      delegationMessage: 'Christopher, please make a pepperoni pizza.',
      proofImagesBase64: ['mushroom-pizza-proof-base64'],
      workerReply: 'We were out of pepperoni so I made this instead — is mushroom okay?',
      householdRulesText: null,
    });

    expect(result.status).toBe('correction_required');
  });

  it('4. AUTHORIZED EXCEPTION: household rules explicitly cover this exact substitution — the model may approve directly, no owner decision required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"APPROVED","correction_message":null,"reasoning":"Blueberries are an approved substitute for strawberries per the stored household rule."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Ask Christopher to buy strawberries for the fruit platter.',
      delegationMessage: 'Christopher, please buy strawberries for the fruit platter.',
      proofImagesBase64: ['blueberries-proof-base64'],
      householdRulesText: 'Blueberries are an approved substitute for strawberries in any recipe.',
    });

    expect(result).toEqual({
      status: 'approved',
      note: 'Blueberries are an approved substitute for strawberries per the stored household rule.',
    });
  });

  it('5. household rules text exists (covers unrelated items) but the model still judges this specific substitution as needing owner review — SUBSTITUTE_REVIEW is NOT blindly downgraded merely because some rules text exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"SUBSTITUTE_REVIEW","correction_message":null,"reasoning":"No stored rule covers pepperoni-to-mushroom; owner review needed."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Ask Christopher to make a pepperoni pizza.',
      delegationMessage: 'Christopher, please make a pepperoni pizza.',
      proofImagesBase64: ['mushroom-pizza-proof-base64'],
      householdRulesText: 'Blueberries are an approved substitute for strawberries in any recipe.',
    });

    expect(result.status).toBe('substitute_review');
  });

  it('6. household rules text is passed into the review prompt verbatim when present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse('{"result":"APPROVED","correction_message":null,"reasoning":"ok"}'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Ask Christopher to buy strawberries.',
      delegationMessage: 'Christopher, please buy strawberries.',
      proofImagesBase64: ['proof-base64'],
      householdRulesText: 'Blueberries are an approved substitute for strawberries in any recipe.',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const promptText = body.messages[0].content.find((block) => block.type === 'text').text;
    expect(promptText).toContain('Blueberries are an approved substitute for strawberries in any recipe.');
  });

  it('7. the prompt explicitly forbids inferring authorization from mere similarity/plausibility/cost/convenience', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse('{"result":"APPROVED","correction_message":null,"reasoning":"ok"}'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Ask Christopher to make a pepperoni pizza.',
      delegationMessage: 'Christopher, please make a pepperoni pizza.',
      proofImagesBase64: ['mushroom-pizza-proof-base64'],
      householdRulesText: null,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const promptText = body.messages[0].content.find((block) => block.type === 'text').text;
    expect(promptText).toMatch(/never infer authorization/i);
    expect(promptText).toMatch(/similarity|plausibility|convenience/i);
  });

  it('8. regression: an entirely different/mismatched item (wrong product category) still returns CORRECTION_REQUIRED as before, unaffected by the household-rules plumbing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"CORRECTION_REQUIRED","correction_message":"Christopher, this is a salad, not the pizza that was requested.","reasoning":"Wrong item."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Ask Christopher to make this for lunch.',
      delegationMessage: 'Christopher, please make this pizza for lunch.',
      referenceImagesBase64: ['pizza-reference-base64'],
      proofImagesBase64: ['salad-proof-base64'],
      householdRulesText: null,
    });

    expect(result.status).toBe('correction_required');
    expect(result.note).toContain('salad');
  });

  it('9. regression: ordinary matching proof with no household rules involved is still approved normally', async () => {
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
      referenceImagesBase64: ['pizza-reference-base64'],
      proofImagesBase64: ['pepperoni-pizza-proof-base64'],
      householdRulesText: null,
    });

    expect(result).toEqual({
      status: 'approved',
      note: 'The proof shows a pepperoni pizza matching the reference.',
    });
  });

  it('10. omitting householdRulesText entirely (not just null) is treated the same as no authority — deterministic downgrade still applies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(
          '{"result":"SUBSTITUTE_REVIEW","correction_message":null,"reasoning":"Mushroom pizza submitted instead of pepperoni."}',
        ),
      ),
    );

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'Ask Christopher to make a pepperoni pizza.',
      delegationMessage: 'Christopher, please make a pepperoni pizza.',
      proofImagesBase64: ['mushroom-pizza-proof-base64'],
      // householdRulesText intentionally omitted
    });

    expect(result.status).toBe('correction_required');
  });
});
