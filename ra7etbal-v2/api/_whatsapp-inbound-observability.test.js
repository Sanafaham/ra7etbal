import { beforeEach, describe, expect, it, vi } from 'vitest';
import { persistWhatsappInboundEvidence } from './_whatsapp-inbound-observability.js';

const base = {
  supabaseUrl: 'https://example.supabase.co',
  serviceKey: 'service-key',
  evidence: {
    inboundMetaMessageId: 'wamid.inbound',
    contextPresent: true,
    rawContextId: 'wamid.quoted',
    rawContextFrom: '15550001111',
    messageType: 'text',
    senderPhone: '905010589614',
    businessNumberId: '1196495893537506',
    webhookReceivedAt: '2026-08-05T19:53:21.700Z',
  },
  normalizedMessage: { contextMessageId: 'wamid.quoted' },
};

describe('WhatsApp inbound observability persistence', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('persists only raw and normalized correlation metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    expect(await persistWhatsappInboundEvidence(base)).toEqual({ ok: true });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.supabase.co/rest/v1/rpc/record_whatsapp_inbound_evidence');
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      p_inbound_meta_message_id: 'wamid.inbound',
      p_context_present: true,
      p_raw_context_id: 'wamid.quoted',
      p_raw_context_from: '15550001111',
      p_message_type: 'text',
      p_sender_phone: '905010589614',
      p_business_number_id: '1196495893537506',
      p_webhook_received_at: '2026-08-05T19:53:21.700Z',
      p_normalized_context_message_id: 'wamid.quoted',
    });
    expect(options.body).not.toContain('Approve it');
    expect(options.body).not.toContain('entry');
  });

  it('preserves null context without manufacturing an identifier', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await persistWhatsappInboundEvidence({
      ...base,
      evidence: { ...base.evidence, contextPresent: false, rawContextId: null, rawContextFrom: null },
      normalizedMessage: { contextMessageId: null },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.p_raw_context_id).toBeNull();
    expect(body.p_context_present).toBe(false);
    expect(body.p_raw_context_from).toBeNull();
    expect(body.p_normalized_context_message_id).toBeNull();
  });

  it('fails isolated when evidence persistence is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, text: vi.fn().mockResolvedValue('storage unavailable'),
    }));
    expect(await persistWhatsappInboundEvidence(base)).toEqual({
      ok: false, reason: 'storage unavailable',
    });
  });
});
