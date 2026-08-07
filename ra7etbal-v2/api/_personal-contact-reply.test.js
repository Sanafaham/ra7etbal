import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMetaMessage = vi.hoisted(() => vi.fn());
vi.mock('./send-whatsapp-task.js', () => ({ sendMetaMessage }));

import { buildOwnerNotificationText, correlateReply, handleInboundPersonalContactReply } from './_personal-contact-reply.js';

const SUPABASE = 'https://example.supabase.co';
const USER_ID = 'user-1';
const PERSON = { id: 'person-eren', name: 'Eren', phone: '+905537032912' };

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(data), text: vi.fn().mockResolvedValue('') };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env.WHATSAPP_ACCESS_TOKEN = 'wa-token';
  sendMetaMessage.mockReset();
  sendMetaMessage.mockResolvedValue({ ok: true, messageId: 'wamid.owner-notify-1' });
});

describe('correlateReply — deterministic priority order', () => {
  it('matches quoted context WAMID against a direct-message delivery for this sender', async () => {
    const fetchMock = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('meta_message_id=eq.wamid.out-1')) {
        return response([{ id: 'delivery-1' }]);
      }
      throw new Error(`unexpected fetch ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await correlateReply({
      supabaseUrl: SUPABASE, serviceKey: 'key', userId: USER_ID,
      senderPhone: '905537032912', contextMessageId: 'wamid.out-1',
    });

    expect(result).toEqual({ method: 'quoted_context', deliveryId: 'delivery-1' });
  });

  it('falls back to a single eligible recent conversation when there is no quoted context', async () => {
    const fetchMock = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/whatsapp_deliveries?') && target.includes('created_at=gte.')) {
        return response([{ id: 'delivery-recent', created_at: '2026-08-07T20:37:07Z' }]);
      }
      if (target.includes('/personal_contact_replies?')) {
        return response([]);
      }
      throw new Error(`unexpected fetch ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await correlateReply({
      supabaseUrl: SUPABASE, serviceKey: 'key', userId: USER_ID,
      senderPhone: '905537032912', contextMessageId: null,
    });

    expect(result).toEqual({ method: 'single_recent', deliveryId: 'delivery-recent' });
  });

  it('excludes a candidate that already has a correlated reply (never uses delivery_status as the eligibility proxy)', async () => {
    const fetchMock = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/whatsapp_deliveries?') && target.includes('created_at=gte.')) {
        return response([
          { id: 'delivery-already-replied', created_at: '2026-08-07T20:00:00Z' },
          { id: 'delivery-fresh', created_at: '2026-08-07T21:00:00Z' },
        ]);
      }
      if (target.includes('/personal_contact_replies?')) {
        return response([{ correlated_delivery_id: 'delivery-already-replied' }]);
      }
      throw new Error(`unexpected fetch ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await correlateReply({
      supabaseUrl: SUPABASE, serviceKey: 'key', userId: USER_ID,
      senderPhone: '905537032912', contextMessageId: null,
    });

    expect(result).toEqual({ method: 'single_recent', deliveryId: 'delivery-fresh' });
  });

  it('fails closed (unmatched) when multiple eligible conversations exist — never guesses', async () => {
    const fetchMock = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/whatsapp_deliveries?') && target.includes('created_at=gte.')) {
        return response([
          { id: 'delivery-a', created_at: '2026-08-07T20:00:00Z' },
          { id: 'delivery-b', created_at: '2026-08-07T21:00:00Z' },
        ]);
      }
      if (target.includes('/personal_contact_replies?')) {
        return response([]);
      }
      throw new Error(`unexpected fetch ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await correlateReply({
      supabaseUrl: SUPABASE, serviceKey: 'key', userId: USER_ID,
      senderPhone: '905537032912', contextMessageId: null,
    });

    expect(result).toEqual({ method: 'unmatched', deliveryId: null });
  });

  it('fails closed (unmatched) when zero recent conversations exist', async () => {
    const fetchMock = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/whatsapp_deliveries?') && target.includes('created_at=gte.')) {
        return response([]);
      }
      throw new Error(`unexpected fetch ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await correlateReply({
      supabaseUrl: SUPABASE, serviceKey: 'key', userId: USER_ID,
      senderPhone: '905537032912', contextMessageId: null,
    });

    expect(result).toEqual({ method: 'unmatched', deliveryId: null });
  });
});

describe('buildOwnerNotificationText', () => {
  it('relays the plain reply without invented context on a resolved correlation', () => {
    const text = buildOwnerNotificationText({
      personName: 'Eren', inboundText: 'Yes.', correlation: { method: 'single_recent', deliveryId: 'd-1' },
    });
    expect(text).toBe('Eren replied: "Yes."');
  });

  it('adds an explicit non-correlation disclosure instead of a false correlation claim', () => {
    const text = buildOwnerNotificationText({
      personName: 'Eren', inboundText: 'Yes.', correlation: { method: 'unmatched', deliveryId: null },
    });
    expect(text).toBe('Eren replied: "Yes." I couldn\'t safely match this to a recent message.');
  });
});

describe('handleInboundPersonalContactReply — end-to-end persistence, relay, and isolation', () => {
  function stubHappyPath({ newlyRecorded = true, correlationDeliveryId = 'delivery-1' } = {}) {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const target = String(url);
      if (target.includes('/whatsapp_deliveries?') && target.includes('meta_message_id=eq.')) {
        return response(correlationDeliveryId ? [{ id: correlationDeliveryId }] : []);
      }
      if (target.includes('/whatsapp_deliveries?') && target.includes('created_at=gte.')) {
        // No contextMessageId was supplied for the unmatched-case test, or the
        // quoted lookup above returned nothing — either way there is no
        // recent-conversation fallback candidate in this fixture.
        return response([]);
      }
      if (target.includes('/rpc/record_personal_contact_reply')) {
        return response([{ row_id: 'reply-1', newly_recorded: newlyRecorded, owner_notification_status: newlyRecorded ? 'pending' : 'sent' }]);
      }
      if (target.includes('/people?')) {
        return response([{ id: 'owner-1', name: 'Boss', role: 'Boss', phone: '+971500000001' }]);
      }
      if (target.includes('/rpc/complete_personal_contact_reply_notification')) {
        return response([{ id: 'reply-1', owner_notification_status: 'sent' }]);
      }
      throw new Error(`unexpected fetch ${target}`);
    }));
    return calls;
  }

  it('persists the reply, relays it to the owner, and marks the notification sent', async () => {
    const calls = stubHappyPath({ correlationDeliveryId: 'delivery-1' });

    const result = await handleInboundPersonalContactReply({
      supabaseUrl: SUPABASE, serviceKey: 'key', userId: USER_ID, person: PERSON,
      msg: { from: '905537032912', messageId: 'wamid.family-1', body: 'Yes.', phoneNumberId: 'meta-phone-id', contextMessageId: 'wamid.out-1' },
    });

    expect(result).toMatchObject({ handled: true, reason: 'relayed', route: 'personal_contact_reply', correlationMethod: 'quoted_context' });
    expect(sendMetaMessage).toHaveBeenCalledTimes(1);
    expect(sendMetaMessage.mock.calls[0][0].payload).toMatchObject({
      to: '971500000001',
      text: { body: 'Eren replied: "Yes."' },
    });
    const recordCall = calls.find((c) => c.url.includes('/rpc/record_personal_contact_reply'));
    expect(JSON.parse(recordCall.options.body)).toMatchObject({
      p_user_id: USER_ID, p_person_id: 'person-eren', p_external_message_id: 'wamid.family-1',
      p_inbound_text: 'Yes.', p_correlation_method: 'quoted_context', p_correlated_delivery_id: 'delivery-1',
    });
    const completeCall = calls.find((c) => c.url.includes('/rpc/complete_personal_contact_reply_notification'));
    expect(JSON.parse(completeCall.options.body)).toMatchObject({ p_id: 'reply-1', p_status: 'sent' });
  });

  it('is idempotent: a duplicate webhook delivery for the same external_message_id sends no second owner notification', async () => {
    stubHappyPath({ newlyRecorded: false });

    const result = await handleInboundPersonalContactReply({
      supabaseUrl: SUPABASE, serviceKey: 'key', userId: USER_ID, person: PERSON,
      msg: { from: '905537032912', messageId: 'wamid.family-1', body: 'Yes.', phoneNumberId: 'meta-phone-id', contextMessageId: 'wamid.out-1' },
    });

    expect(result).toEqual({ handled: true, reason: 'duplicate', route: 'personal_contact_reply' });
    expect(sendMetaMessage).not.toHaveBeenCalled();
  });

  it('never discards an unmatched reply — persists it and notifies the owner without a false correlation', async () => {
    const calls = stubHappyPath({ correlationDeliveryId: null });

    const result = await handleInboundPersonalContactReply({
      supabaseUrl: SUPABASE, serviceKey: 'key', userId: USER_ID, person: PERSON,
      msg: { from: '905537032912', messageId: 'wamid.family-2', body: 'Yes.', phoneNumberId: 'meta-phone-id', contextMessageId: null },
    });

    expect(result.handled).toBe(true);
    expect(result.correlationMethod).toBe('unmatched');
    const recordCall = calls.find((c) => c.url.includes('/rpc/record_personal_contact_reply'));
    expect(JSON.parse(recordCall.options.body)).toMatchObject({
      p_correlation_method: 'unmatched', p_correlated_delivery_id: null,
    });
    expect(sendMetaMessage.mock.calls[0][0].payload.text.body)
      .toBe('Eren replied: "Yes." I couldn\'t safely match this to a recent message.');
  });

  it('never routes a family reply through any staff/task/QI/escalation module', async () => {
    // No staff_messages, tasks, staff_escalation_owner_decisions, or
    // Quality Intelligence endpoint is stubbed above — if this module ever
    // touched one of those tables, the unmocked fetch would throw
    // "unexpected fetch", failing this test.
    stubHappyPath({ correlationDeliveryId: 'delivery-1' });
    const result = await handleInboundPersonalContactReply({
      supabaseUrl: SUPABASE, serviceKey: 'key', userId: USER_ID, person: PERSON,
      msg: { from: '905537032912', messageId: 'wamid.family-3', body: 'Yes.', phoneNumberId: 'meta-phone-id', contextMessageId: 'wamid.out-1' },
    });
    expect(result.handled).toBe(true);
  });

  it('does not process a media-only reply with no text (out of scope, does not crash or fabricate state)', async () => {
    const result = await handleInboundPersonalContactReply({
      supabaseUrl: SUPABASE, serviceKey: 'key', userId: USER_ID, person: PERSON,
      msg: { from: '905537032912', messageId: 'wamid.family-4', body: '', phoneNumberId: 'meta-phone-id', contextMessageId: null },
    });
    expect(result).toEqual({ handled: false, reason: 'empty_reply_not_supported', route: 'personal_contact_reply' });
    expect(sendMetaMessage).not.toHaveBeenCalled();
  });
});
