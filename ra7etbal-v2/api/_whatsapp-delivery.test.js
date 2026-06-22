import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginWhatsappDelivery,
  getMetaFailure,
  markWhatsappDeliveryAccepted,
  markWhatsappDeliveryFailed,
} from './_whatsapp-delivery.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WhatsApp delivery persistence', () => {
  it('derives ownership from a task and creates a pending delivery row', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }]));
    vi.stubGlobal('fetch', fetchMock);

    const deliveryId = await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      taskId: 'task-1',
      sourceType: 'delegation',
      recipientPhone: '971500000000',
      recipientName: 'Grace',
    });

    expect(deliveryId).toBe('delivery-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const insertOptions = fetchMock.mock.calls[1][1];
    const inserted = JSON.parse(insertOptions.body);
    expect(inserted).toMatchObject({
      user_id: 'user-1',
      task_id: 'task-1',
      source_type: 'delegation',
      delivery_status: 'pending',
      recipient_phone: '971500000000',
      recipient_name: 'Grace',
    });
  });

  it('fails open when delivery storage is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('storage unavailable')));

    await expect(
      beginWhatsappDelivery({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        taskId: 'task-1',
        sourceType: 'delegation',
      }),
    ).resolves.toBeNull();
  });

  it('fails open when accepted and failed status updates cannot be stored', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('patch unavailable')));

    await expect(
      markWhatsappDeliveryAccepted({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        deliveryId: 'delivery-1',
        metaMessageId: 'wamid.1',
      }),
    ).resolves.toBeUndefined();

    await expect(
      markWhatsappDeliveryFailed({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        deliveryId: 'delivery-1',
        failureStage: 'network',
        reason: 'network down',
      }),
    ).resolves.toBeUndefined();
  });

  it('extracts structured Meta failure details', () => {
    expect(
      getMetaFailure({
        status: 400,
        metaError: {
          code: 131047,
          error_subcode: 2494010,
          message: 'Message failed',
          error_data: { details: 'Recipient unavailable' },
        },
      }),
    ).toEqual({
      httpStatus: 400,
      code: 131047,
      subcode: 2494010,
      reason: 'Recipient unavailable',
    });
  });
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}
