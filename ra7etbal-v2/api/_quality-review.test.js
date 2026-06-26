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
      proofImageBase64: 'proof-base64',
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
      proofImageBase64: 'proof-base64',
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
      proofImageBase64: 'proof-base64',
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
      proofImageBase64: 'proof-base64',
    });

    expect(result).toEqual({ status: 'uncertain', note: 'Photo is too blurry to tell.' });
  });

  it('falls back to uncertain when the Anthropic API call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const result = await runQualityReview({
      apiKey: 'test-key',
      taskDescription: 'task',
      delegationMessage: 'message',
      referenceImageBase64: null,
      proofImageBase64: 'proof-base64',
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
      proofImageBase64: 'proof-base64',
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
      proofImageBase64: null,
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
      proofImageBase64: 'proof-base64',
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
      proofImageBase64: 'proof-base64',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const images = body.messages[0].content.filter((block) => block.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0].source.data).toBe('ref-base64');
    expect(images[1].source.data).toBe('proof-base64');
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
