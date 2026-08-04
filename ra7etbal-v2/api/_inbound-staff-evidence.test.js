import { describe, expect, it, vi } from 'vitest';
import { MAX_INBOUND_IMAGE_BYTES, persistInboundStaffImage } from './_inbound-staff-evidence.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer),
  };
}

const INPUT = {
  mediaId: 'media-1', mimeType: 'image/jpeg', userId: 'user-1', taskId: 'task-1',
  messageId: 'wamid.A/B', accessToken: 'meta-token',
  supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
};

describe('inbound staff evidence transport adapter', () => {
  it('downloads Meta media and persists it in the task proof namespace at an idempotent path', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ url: 'https://lookaside.example/media', mime_type: 'image/jpeg', file_size: 3 }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}));

    const result = await persistInboundStaffImage(INPUT, { fetchImpl });

    expect(result).toEqual({
      ok: true,
      storagePath: 'task-images/user-1/task-1/proof/whatsapp-wamid.A_B.jpg',
      mimeType: 'image/jpeg',
      size: 4,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(1,
      'https://graph.facebook.com/v20.0/media-1',
      { headers: { Authorization: 'Bearer meta-token' } },
    );
    expect(fetchImpl.mock.calls[2][0]).toBe(
      'https://x.supabase.co/storage/v1/object/task-images/user-1/task-1/proof/whatsapp-wamid.A_B.jpg',
    );
    expect(fetchImpl.mock.calls[2][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'x-upsert': 'true', 'Content-Type': 'image/jpeg' }),
      body: expect.any(Buffer),
    });
  });

  it.each([
    ['unsupported type', { ...INPUT, mimeType: 'application/pdf' }, 'unsupported_media_type'],
    ['missing context', { ...INPUT, taskId: null }, 'missing_media_context'],
  ])('fails closed for %s', async (_label, input, reason) => {
    const fetchImpl = vi.fn();
    await expect(persistInboundStaffImage(input, { fetchImpl })).resolves.toEqual({ ok: false, reason });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects oversized media before downloading bytes', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({
      url: 'https://lookaside.example/media', mime_type: 'image/jpeg', file_size: MAX_INBOUND_IMAGE_BYTES + 1,
    }));
    await expect(persistInboundStaffImage(INPUT, { fetchImpl })).resolves.toEqual({ ok: false, reason: 'media_too_large' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not return a proof path when storage rejects the upload', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ url: 'https://lookaside.example/media', mime_type: 'image/jpeg', file_size: 3 }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}, 500));
    await expect(persistInboundStaffImage(INPUT, { fetchImpl })).resolves.toEqual({ ok: false, reason: 'media_storage_failed' });
  });
});
