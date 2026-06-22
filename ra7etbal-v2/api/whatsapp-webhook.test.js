import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDeliveryStatusPatch,
  updateWhatsappDeliveryStatus,
} from './whatsapp-webhook.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WhatsApp delivery status progression', () => {
  it('advances accepted through sent, delivered, and read with timestamps', () => {
    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'accepted',
        incomingStatus: 'sent',
        updatedAt: '2026-06-22T18:00:00Z',
        currentLastStatusAt: null,
      }),
    ).toEqual({
      delivery_status: 'sent',
      sent_at: '2026-06-22T18:00:00.000Z',
      last_status_at: '2026-06-22T18:00:00.000Z',
    });

    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'sent',
        incomingStatus: 'delivered',
        updatedAt: '2026-06-22T18:01:00Z',
        currentLastStatusAt: '2026-06-22T18:00:00Z',
      }),
    ).toMatchObject({
      delivery_status: 'delivered',
      delivered_at: '2026-06-22T18:01:00.000Z',
    });

    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'delivered',
        incomingStatus: 'read',
        updatedAt: '2026-06-22T18:02:00Z',
        currentLastStatusAt: '2026-06-22T18:01:00Z',
      }),
    ).toMatchObject({
      delivery_status: 'read',
      read_at: '2026-06-22T18:02:00.000Z',
    });
  });

  it('does not regress state on an out-of-order webhook', () => {
    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'read',
        incomingStatus: 'delivered',
        updatedAt: '2026-06-22T18:03:00Z',
        currentLastStatusAt: '2026-06-22T18:02:00Z',
      }),
    ).toEqual({
      last_status_at: '2026-06-22T18:03:00.000Z',
    });
  });

  it('does not overwrite a milestone timestamp on a duplicate status', () => {
    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'delivered',
        incomingStatus: 'delivered',
        updatedAt: '2026-06-22T18:03:00Z',
        currentLastStatusAt: '2026-06-22T18:02:00Z',
      }),
    ).toEqual({
      last_status_at: '2026-06-22T18:03:00.000Z',
    });
  });

  it('makes failed terminal', () => {
    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'accepted',
        incomingStatus: 'failed',
        updatedAt: '2026-06-22T18:04:00Z',
        failureReason: 'Recipient unavailable',
      }),
    ).toMatchObject({
      delivery_status: 'failed',
      failed_at: '2026-06-22T18:04:00.000Z',
      failure_stage: 'meta_api',
      failure_reason: 'Recipient unavailable',
    });

    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'failed',
        incomingStatus: 'delivered',
        updatedAt: '2026-06-22T18:05:00Z',
      }),
    ).toBeNull();
  });

  it('fails open when canonical delivery storage is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('database unavailable')));

    await expect(
      updateWhatsappDeliveryStatus({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        messageId: 'wamid.1',
        status: 'delivered',
        updatedAt: '2026-06-22T18:01:00Z',
      }),
    ).resolves.toMatchObject({
      matched: false,
      updated: false,
      error: 'unexpected_error',
    });
  });

  it('updates the matched delivery and health timestamps', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 'delivery-1',
          user_id: 'user-1',
          delivery_status: 'accepted',
          last_status_at: null,
        },
      ]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.1',
      status: 'delivered',
      updatedAt: '2026-06-22T18:01:00Z',
      phoneNumberId: 'phone-number-1',
      webhookReceivedAt: '2026-06-22T18:01:05Z',
    });

    expect(result).toMatchObject({
      matched: true,
      updated: true,
      deliveryId: 'delivery-1',
    });

    const healthBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(healthBody).toMatchObject({
      user_id: 'user-1',
      phone_number_id: 'phone-number-1',
      last_webhook_received_at: '2026-06-22T18:01:05Z',
      last_status_webhook_at: '2026-06-22T18:01:05Z',
      last_matched_status_at: '2026-06-22T18:01:05Z',
      last_delivered_at: '2026-06-22T18:01:05Z',
    });

    const deliveryBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(deliveryBody).toEqual({
      delivery_status: 'delivered',
      delivered_at: '2026-06-22T18:01:00.000Z',
      last_status_at: '2026-06-22T18:01:00.000Z',
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
