import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callRpcRows: vi.fn(),
  callRpcSingle: vi.fn(),
  resolve: vi.fn(),
  sendMetaMessage: vi.fn(),
  executeCommand: vi.fn(),
  recordInbound: vi.fn(),
  updateCommand: vi.fn(),
  ownerConversationalTurn: vi.fn(),
}));

vi.mock('./task-confirm.js', () => ({
  callRpcRows: mocks.callRpcRows,
  callRpcSingle: mocks.callRpcSingle,
  resolveAndDeliverEscalationAnswer: mocks.resolve,
}));
vi.mock('./send-whatsapp-task.js', () => ({
  default: vi.fn(),
  sendMetaMessage: mocks.sendMetaMessage,
}));
vi.mock('./_owner-command-executor.js', () => ({
  persistAndExecuteOwnerCommand: mocks.executeCommand,
  recordOwnerInbound: mocks.recordInbound,
  updateCommand: mocks.updateCommand,
}));
vi.mock('./_carson-agent-turn.js', () => ({
  attemptCarsonBridgePoc: vi.fn(),
  runOwnerConversationalTurn: mocks.ownerConversationalTurn,
}));

import {
  handleInboundOwnerMessage,
  isDisambiguationSelectorMessage,
  isDecisionShapedMessage,
  normalizeOwnerDecisionReply,
  reconcileOwnerWhatsappMessages,
  resolveCanonicalOwner,
  selectDisambiguationCandidate,
} from './_owner-whatsapp-routing.js';

const SUPABASE = 'https://example.supabase.co';
const KEY = 'service-key';
const owner = { id: 'boss-1', name: 'Sana', role: 'boss', phone: '+971501234567' };
const claim = {
  receipt_id: 'receipt-1',
  claimed: true,
  claim_token: 'claim-1',
  status: 'claimed',
  outcome: null,
};

function msg(overrides = {}) {
  return {
    from: '971501234567',
    messageId: 'wamid.in-1',
    body: 'Yes, please do that.',
    phoneNumberId: 'meta-phone-1',
    contextMessageId: null,
    ...overrides,
  };
}

function response(data, ok = true) {
  return { ok, json: vi.fn().mockResolvedValue(data) };
}

function stubIdentity(fetchMock, people = [owner]) {
  fetchMock
    .mockResolvedValueOnce(response([{ user_id: 'user-1' }]))
    .mockResolvedValueOnce(response(people));
}

function stubClaim() {
  mocks.callRpcRows.mockResolvedValueOnce({ data: [claim] });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env.WHATSAPP_ACCESS_TOKEN = 'token';
  process.env.OWNER_WHATSAPP_ROUTING_USER_IDS = 'user-1';
  mocks.callRpcRows.mockReset();
  mocks.callRpcSingle.mockReset();
  mocks.resolve.mockReset();
  mocks.sendMetaMessage.mockReset();
  mocks.executeCommand.mockReset();
  mocks.recordInbound.mockReset();
  mocks.updateCommand.mockReset();
  mocks.callRpcSingle.mockResolvedValue({ data: { status: 'completed' } });
  mocks.sendMetaMessage.mockResolvedValue({ ok: true, messageId: 'wamid.ack-1' });
  mocks.executeCommand.mockResolvedValue({
    kind: 'completed',
    acknowledgement: 'Done — command completed.',
    acknowledgementAlreadyAccepted: false,
  });
  mocks.recordInbound.mockResolvedValue({
    data: { acknowledgement_status: 'pending' },
    error: null,
  });
  mocks.updateCommand.mockResolvedValue({});
  mocks.ownerConversationalTurn.mockResolvedValue({
    handled: true,
    route: 'owner_conversational',
    reason: 'answered',
  });
});

describe('general owner command safety', () => {
  for (const [label, body] of [
    ['one escalation exists', 'Remind me to pay the electricity bill tomorrow.'],
    ['multiple escalations exist', 'Tell Christopher to make pizza.'],
  ]) {
    it(`${label}: execution domain routes to command executor without reading escalations`, async () => {
      const fetchMock = vi.fn();
      stubIdentity(fetchMock);
      vi.stubGlobal('fetch', fetchMock);
      stubClaim();

      const result = await handleInboundOwnerMessage({
        supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg({ body }),
      });

      expect(result).toMatchObject({
        isOwner: true,
        handled: true,
        route: 'general_command',
        execution: 'completed',
      });
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
      expect(mocks.ownerConversationalTurn).not.toHaveBeenCalled();
      expect(mocks.sendMetaMessage).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).includes('staff_escalation_owner_decisions'))).toBe(false);
      expect(mocks.callRpcSingle).toHaveBeenCalledWith(
        SUPABASE, KEY, 'complete_owner_whatsapp_reply',
        expect.objectContaining({ p_outcome: 'general_command_executed', p_escalation_id: null }),
      );
    });
  }

  it('conversational domain routes to Carson bridge without calling command executor', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg({ body: 'What still needs my attention?' }),
    });

    expect(result).toMatchObject({
      isOwner: true,
      handled: true,
      route: 'owner_conversational',
    });
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.ownerConversationalTurn).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('staff_escalation_owner_decisions'))).toBe(false);
  });


  it('queries recent open decisions only behind the explicit decision-shape guard', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./_owner-whatsapp-routing.js', import.meta.url), 'utf8'));
    expect(source).toContain('isDecisionShapedMessage(msg.body)');
    expect(source).toContain('&status=eq.open&created_at=gte.');
    expect(source).toContain("requireOwnerNotification: true");
  });

  it('an already-accepted owner acknowledgement is not resent', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.executeCommand.mockResolvedValue({
      kind: 'completed',
      acknowledgement: 'Done — command completed.',
      acknowledgementAlreadyAccepted: true,
    });

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg({ body: 'Ask Grace to call me.' }),
    });

    expect(result).toMatchObject({ handled: true, execution: 'completed' });
    expect(mocks.sendMetaMessage).not.toHaveBeenCalled();
  });

  it('retryable execution failure remains failed instead of being falsely completed', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.executeCommand.mockResolvedValue({
      kind: 'execution_failed',
      acknowledgement: 'I could not complete it; Ra7etBal will retry safely.',
      acknowledgementAlreadyAccepted: false,
      error: 'transient_failure',
    });

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg({ body: 'Ask Grace to clean the kitchen.' }),
    });

    expect(result).toMatchObject({
      handled: false,
      execution: 'execution_failed',
      reason: 'command_execution_failed',
    });
    expect(mocks.callRpcSingle).toHaveBeenCalledWith(
      SUPABASE, KEY, 'fail_owner_whatsapp_reply',
      expect.objectContaining({ p_error: 'transient_failure' }),
    );
    expect(mocks.callRpcSingle).not.toHaveBeenCalledWith(
      SUPABASE, KEY, 'complete_owner_whatsapp_reply', expect.anything(),
    );
  });

  it('does not resend or overwrite an already accepted failure acknowledgement during retry', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.executeCommand.mockResolvedValue({
      kind: 'execution_failed',
      acknowledgement: 'I could not complete it; Ra7etBal will retry safely.',
      acknowledgementAlreadyAccepted: true,
      error: 'transient_failure',
    });

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg({ body: 'Ask Grace to clean the kitchen.' }),
    });

    expect(result).toMatchObject({
      handled: false,
      execution: 'execution_failed',
      reason: 'command_execution_failed',
    });
    expect(mocks.sendMetaMessage).not.toHaveBeenCalled();
    expect(mocks.updateCommand).not.toHaveBeenCalledWith(
      SUPABASE,
      KEY,
      expect.anything(),
      'user-1',
      expect.objectContaining({ acknowledgement_transport_message_id: expect.anything() }),
    );
  });

  it('terminal execution failure completes with a durable non-success outcome', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.executeCommand.mockResolvedValue({
      kind: 'terminal_failed',
      acknowledgement: 'Nothing was scheduled and no further retry is scheduled.',
      acknowledgementAlreadyAccepted: false,
      error: 'reminder_time_parse_failed',
    });

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg({ body: 'Remind me tomorrow.' }),
    });

    expect(result).toMatchObject({ handled: true, execution: 'terminal_failed' });
    expect(mocks.callRpcSingle).toHaveBeenCalledWith(
      SUPABASE, KEY, 'complete_owner_whatsapp_reply',
      expect.objectContaining({ p_outcome: 'terminal_failure' }),
    );
  });
});

describe('owner command reconciliation safety', () => {
  it('excludes terminal_failed receipts before retry processing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([]));
    vi.stubGlobal('fetch', fetchMock);

    const results = await reconcileOwnerWhatsappMessages({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
    });

    expect(results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'execution_status=neq.terminal_failed',
    );
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.sendMetaMessage).not.toHaveBeenCalled();
  });

  // regression (2026-08-02): quoted_escalation receipt with null context_message_id
  // was retried by the reconciler on every cron tick, falling through to the
  // conversational bridge and sending repeated spurious WhatsApp messages.
  it('regression (2026-08-02): quoted_escalation with null context is never retried', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{
        id: 'receipt-orphan',
        user_id: 'user-1',
        external_message_id: 'wamid.orphan',
        inbound_text: 'Yes buy it',
        sender_phone: '905010589614',
        phone_number_id: 'phone-1',
        context_message_id: null,
        route: 'quoted_escalation',
      }]))
      // second call = the terminal_failed PATCH
      .mockResolvedValueOnce(response([{ id: 'receipt-orphan' }]));
    vi.stubGlobal('fetch', fetchMock);

    const results = await reconcileOwnerWhatsappMessages({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
    });

    expect(results).toEqual([]);
    expect(mocks.ownerConversationalTurn).not.toHaveBeenCalled();
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.sendMetaMessage).not.toHaveBeenCalled();

    const patchCall = fetchMock.mock.calls[1];
    expect(patchCall[1].method).toBe('PATCH');
    expect(String(patchCall[0])).toContain('receipt-orphan');
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody.execution_status).toBe('terminal_failed');
    expect(patchBody.execution_error).toBe('quoted_escalation_missing_context');
  });

  it('regression (2026-08-02): quoted_escalation WITH valid context is still retried normally', async () => {
    stubClaim();
    mocks.resolve.mockResolvedValue({ kind: 'success', status: 'delivered', ownerReplyText: 'Yes' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{
        id: 'receipt-valid',
        user_id: 'user-1',
        external_message_id: 'wamid.valid',
        inbound_text: 'Yes buy it',
        sender_phone: '905010589614',
        phone_number_id: 'phone-1',
        context_message_id: 'wamid.escalation-notification',
        route: 'quoted_escalation',
      }]))
      // identity + people
      .mockResolvedValueOnce(response([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(response([owner]))
      // whatsapp_deliveries lookup for findQuotedEscalation
      .mockResolvedValueOnce(response([{
        metadata: { escalation_id: 'esc-1' },
        recipient_phone: owner.phone,
        delivery_status: 'accepted',
      }]))
      .mockResolvedValueOnce(response([{
        id: 'esc-1', user_id: 'user-1', staff_message_id: 'staff-1',
        status: 'open', owner_reply_text: null, deep_link_token: 'tok-1',
      }]))
      .mockResolvedValueOnce(response([{
        id: 'staff-1', user_id: 'user-1', person_id: 'p-1',
        staff_name: 'Christopher', staff_phone: '+12025691377', inbound_text: 'Found a substitute.',
      }]))
      // recordOwnerInbound + resolve
      .mockResolvedValue(response([{ id: 'receipt-valid' }]));
    vi.stubGlobal('fetch', fetchMock);
    mocks.recordInbound.mockResolvedValue({ data: { acknowledgement_status: null }, error: null });

    const results = await reconcileOwnerWhatsappMessages({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
    });

    expect(results.length).toBe(1);
    expect(mocks.ownerConversationalTurn).not.toHaveBeenCalled();
    // no terminal_failed PATCH was issued — the second fetch call is identity, not PATCH
    const patchCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PATCH');
    expect(patchCalls.every((c) => !String(c[0]).includes('receipt-orphan'))).toBe(true);
  });

  it('regression (2026-08-02): conversational bridge is never invoked for orphan receipt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{
        id: 'receipt-orphan-2',
        user_id: 'user-1',
        external_message_id: 'wamid.orphan-2',
        inbound_text: 'Yes go ahead',
        sender_phone: '905010589614',
        phone_number_id: 'phone-1',
        context_message_id: null,
        route: 'quoted_escalation',
      }]))
      .mockResolvedValueOnce(response([{ id: 'receipt-orphan-2' }]));
    vi.stubGlobal('fetch', fetchMock);

    await reconcileOwnerWhatsappMessages({ supabaseUrl: SUPABASE, serviceKey: KEY });

    expect(mocks.ownerConversationalTurn).not.toHaveBeenCalled();
    expect(mocks.sendMetaMessage).not.toHaveBeenCalled();
  });
});

describe('authoritative quoted escalation routing', () => {
  function stubQuoted(fetchMock, escalationStatus = 'open', deliveryStatus = 'accepted') {
    stubIdentity(fetchMock);
    fetchMock
      .mockResolvedValueOnce(response([{
        metadata: { escalation_id: 'esc-2', owner_phone_number_id: 'meta-phone-1' },
        recipient_phone: owner.phone,
        delivery_status: deliveryStatus,
      }]))
      .mockResolvedValueOnce(response([{
        id: 'esc-2',
        user_id: 'user-1',
        staff_message_id: 'staff-msg-2',
        status: escalationStatus,
        owner_reply_text: escalationStatus === 'open' ? null : 'Earlier answer',
        deep_link_token: 'deep-2',
      }]))
      .mockResolvedValueOnce(response([{
        id: 'staff-msg-2',
        user_id: 'user-1',
        person_id: 'person-2',
        staff_name: 'Christopher',
        staff_phone: '+971500000002',
        inbound_text: 'Can I make pizza tomorrow instead?',
      }]));
  }

  it.each(['accepted', 'sent', 'delivered', 'read'])(
    'valid quote with %s delivery status resolves only the referenced escalation',
    async (deliveryStatus) => {
      const fetchMock = vi.fn();
      stubQuoted(fetchMock, 'open', deliveryStatus);
      vi.stubGlobal('fetch', fetchMock);
      stubClaim();
      mocks.resolve.mockResolvedValue({ kind: 'success', status: 'delivered', ownerReplyText: 'Yes' });

      const result = await handleInboundOwnerMessage({
        supabaseUrl: SUPABASE,
        serviceKey: KEY,
        msg: msg({ contextMessageId: 'wamid.owner-notification-2' }),
      });

      expect(result).toMatchObject({
        handled: true, route: 'quoted_escalation', reason: 'resolved_escalation',
      });
      expect(mocks.resolve).toHaveBeenCalledTimes(1);
      expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        escalation: expect.objectContaining({ id: 'esc-2' }),
        replyChannel: 'whatsapp',
      }));
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).includes('status=eq.open'))).toBe(false);
    },
  );

  it.each([
    'pending',
    'failed',
    'undelivered',
    'expired',
    'deleted',
    'invalid',
    null,
    'unknown',
  ])('quoted context with unsuccessful delivery status %s fails closed', async (deliveryStatus) => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock.mockResolvedValueOnce(response([{
      metadata: { escalation_id: 'esc-2', owner_phone_number_id: 'meta-phone-1' },
      recipient_phone: owner.phone,
      delivery_status: deliveryStatus,
    }]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({ contextMessageId: 'wamid.owner-notification-2' }),
    });

    expect(result).toMatchObject({ handled: true, route: 'unmatched_quote' });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.sendMetaMessage).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('staff_escalation_owner_decisions'))).toBe(false);
  });

  it('unmatched quoted context resolves nothing and sends only a truthful clarification', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock.mockResolvedValueOnce(response([]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({ contextMessageId: 'wamid.unknown' }),
    });

    expect(result).toMatchObject({ handled: true, route: 'unmatched_quote' });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.sendMetaMessage).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('staff_escalation_owner_decisions'))).toBe(false);
  });

  it('quoted context sent to a different owner phone fails closed', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock.mockResolvedValueOnce(response([{
      metadata: { escalation_id: 'esc-other' },
      recipient_phone: '+971500000099',
      delivery_status: 'accepted',
    }]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY,
      msg: msg({ contextMessageId: 'wamid.wrong-recipient' }),
    });

    expect(result).toMatchObject({ handled: true, route: 'unmatched_quote' });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('staff_escalation_owner_decisions'))).toBe(false);
  });

  it('quoted context created for a different business number fails closed', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock.mockResolvedValueOnce(response([{
      metadata: { escalation_id: 'esc-other', owner_phone_number_id: 'meta-phone-other' },
      recipient_phone: owner.phone,
      delivery_status: 'accepted',
    }]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY,
      msg: msg({ contextMessageId: 'wamid.wrong-business' }),
    });

    expect(result).toMatchObject({ handled: true, route: 'unmatched_quote' });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('already-resolved quoted escalation is recorded and silently ignored without another staff send or owner acknowledgement', async () => {
    const fetchMock = vi.fn();
    stubQuoted(fetchMock, 'delivered_to_staff');
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.resolve.mockResolvedValue({
      kind: 'success', status: 'delivered', ownerReplyText: 'Earlier answer',
    });

    await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({ contextMessageId: 'wamid.owner-notification-2' }),
    });

    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.sendMetaMessage).not.toHaveBeenCalled();
    expect(mocks.updateCommand).toHaveBeenCalledWith(
      SUPABASE, KEY, expect.anything(), 'user-1',
      expect.objectContaining({
        execution_result: expect.objectContaining({ duplicate_resolution_ignored: true }),
      }),
    );
  });

  it('quoted escalation plus an unrelated command is rejected without staff leakage or partial execution', async () => {
    const fetchMock = vi.fn();
    stubQuoted(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({
        contextMessageId: 'wamid.owner-notification-2',
        body: 'Yes, and tell Grace to call me.',
      }),
    });

    expect(result).toMatchObject({
      handled: true,
      route: 'quoted_escalation',
      reason: 'compound_rejected',
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.sendMetaMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMetaMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        text: expect.objectContaining({ body: expect.stringContaining('Nothing was sent') }),
      }),
    }));
  });

  it('staff delivery failure is truthful and leaves the receipt failed/retryable', async () => {
    const fetchMock = vi.fn();
    stubQuoted(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.resolve.mockResolvedValue({ kind: 'send_error' });

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({ contextMessageId: 'wamid.owner-notification-2' }),
    });

    expect(result).toMatchObject({
      handled: false, reason: 'staff_delivery_failed', staffDelivery: 'send_error',
    });
    expect(mocks.callRpcSingle).toHaveBeenCalledWith(
      SUPABASE, KEY, 'fail_owner_whatsapp_reply',
      expect.objectContaining({ p_error: 'send_error' }),
    );
    expect(mocks.callRpcSingle).not.toHaveBeenCalledWith(
      SUPABASE, KEY, 'complete_owner_whatsapp_reply', expect.anything(),
    );
  });

  it('owner acknowledgement failure is not described as sent and remains retryable', async () => {
    const fetchMock = vi.fn();
    stubQuoted(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.resolve.mockResolvedValue({ kind: 'success', status: 'delivered', ownerReplyText: 'Yes' });
    mocks.sendMetaMessage.mockResolvedValue({ ok: false, error: 'meta_rejected' });

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({ contextMessageId: 'wamid.owner-notification-2' }),
    });

    expect(result).toMatchObject({
      handled: false, reason: 'owner_ack_failed', staffDelivery: 'delivered',
    });
    expect(mocks.callRpcSingle).toHaveBeenCalledWith(
      SUPABASE, KEY, 'fail_owner_whatsapp_reply',
      expect.objectContaining({ p_error: 'meta_rejected' }),
    );
  });
});

describe('natural owner decision matching and normalization', () => {
  const openDecision = {
    id: '11111111-1111-4111-8111-111111111111',
    user_id: 'user-1',
    staff_message_id: 'staff-msg-2',
    status: 'open',
    owner_reply_text: null,
    deep_link_token: '22222222-2222-4222-8222-222222222222',
    created_at: '2026-07-28T15:00:00.000Z',
  };
  const christopherMessage = {
    id: 'staff-msg-2',
    user_id: 'user-1',
    person_id: 'person-2',
    staff_name: 'Christopher',
    staff_phone: '+971500000002',
    inbound_text: 'Can I buy red wine vinegar instead?',
    owner_notification_status: 'sent',
  };

  it.each([
    ['Yes', 'approved', null],
    ['Approve it', 'approved', null],
    ['No', 'rejected', null],
    ["Don't approve it", 'rejected', null],
    ['Yes, but do not serve it to guests', 'custom_instruction', 'Yes, but do not serve it to guests'],
    ['Buy the red wine vinegar', 'custom_instruction', 'Buy the red wine vinegar'],
    ['No, use another substitute', 'custom_instruction', 'No, use another substitute'],
    ['Ask Christopher for more information', 'custom_instruction', 'Ask Christopher for more information'],
  ])('normalizes %s without losing a conditional or exact instruction', (body, decision, instructionText) => {
    expect(normalizeOwnerDecisionReply(body)).toEqual({ decision, instructionText });
  });

  it('does not classify unrelated yes/no-containing prose or another staff command as a decision reply', () => {
    expect(isDecisionShapedMessage('What still needs my attention?')).toBe(false);
    expect(isDecisionShapedMessage('Ask Grace to call me.')).toBe(false);
    expect(isDecisionShapedMessage('Remind me to check tomorrow.')).toBe(false);
  });

  it('matches a decision-shaped reply to exactly one recently notified open decision', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock
      .mockResolvedValueOnce(response([openDecision]))
      .mockResolvedValueOnce(response([christopherMessage]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.resolve.mockResolvedValue({ kind: 'success', status: 'delivered', ownerReplyText: 'approved' });

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg({ body: 'Approve it' }),
    });

    expect(result).toMatchObject({ handled: true, reason: 'resolved_escalation' });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      escalation: expect.objectContaining({ id: openDecision.id }),
      decision: 'approved',
      instructionText: null,
      replyChannel: 'whatsapp',
    }));
  });

  it('binds a pronoun custom instruction to the one validated pending recipient', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock
      .mockResolvedValueOnce(response([openDecision]))
      .mockResolvedValueOnce(response([{
        ...christopherMessage,
        inbound_text: 'What should I prepare for lunch?',
      }]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.resolve.mockResolvedValue({ kind: 'success', status: 'delivered' });

    await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({ body: 'Tell him to prepare steaks and French fries.' }),
    });

    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      escalation: expect.objectContaining({ id: openDecision.id }),
      staffMessage: expect.objectContaining({ staff_name: 'Christopher' }),
      decision: 'custom_instruction',
      instructionText: 'Tell him to prepare steaks and French fries.',
    }));
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('matches an explicit decision UUID before recent-open inference', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock
      .mockResolvedValueOnce(response([openDecision]))
      .mockResolvedValueOnce(response([christopherMessage]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.resolve.mockResolvedValue({ kind: 'success', status: 'delivered', ownerReplyText: 'instruction' });

    await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({ body: `Decision ${openDecision.id}: Buy the red wine vinegar` }),
    });

    expect(String(fetchMock.mock.calls[2][0])).toContain('or=(id.eq.');
    expect(String(fetchMock.mock.calls[2][0])).not.toContain('status=eq.open');
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it('clarifies two Christopher decisions with the required wording and resolves neither', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock
      .mockResolvedValueOnce(response([
        openDecision,
        { ...openDecision, id: '33333333-3333-4333-8333-333333333333', staff_message_id: 'staff-msg-3' },
      ]))
      .mockResolvedValueOnce(response([{
        ...christopherMessage,
        inbound_text: 'Can I use the dessert plate for tonight?',
      }]))
      .mockResolvedValueOnce(response([christopherMessage]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg({ body: 'Yes' }),
    });

    expect(result).toMatchObject({ handled: true, reason: 'clarification_sent' });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.updateCommand).toHaveBeenCalledWith(
      SUPABASE,
      KEY,
      claim,
      'user-1',
      expect.objectContaining({
        execution_result: expect.objectContaining({
          match_method: 'ambiguous',
          clarification_status: 'pending',
          original_answer: 'Yes',
          candidates: expect.arrayContaining([
            expect.objectContaining({ decision_id: openDecision.id }),
            expect.objectContaining({ decision_id: '33333333-3333-4333-8333-333333333333' }),
          ]),
        }),
      }),
    );
    const persisted = mocks.updateCommand.mock.calls[0][4].execution_result;
    expect(persisted.candidates).toHaveLength(2);
    expect(mocks.sendMetaMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        text: {
          body: 'I have two pending decisions from Christopher. Which one do you mean, the dessert plate or the vinegar purchase?',
        },
      }),
    }));
  });
});

describe('idempotency and identity', () => {
  it('duplicate completed webhook performs no side effects', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    mocks.callRpcRows.mockResolvedValue({
      data: [{ ...claim, claimed: false, claim_token: null, status: 'completed' }],
    });

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg(),
    });
    expect(result).toMatchObject({ route: 'duplicate', reason: 'already_completed' });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.callRpcSingle).not.toHaveBeenCalled();
  });

  it('concurrent duplicate claim lets only the lease holder act', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    mocks.callRpcRows.mockResolvedValue({
      data: [{ ...claim, claimed: false, claim_token: null, status: 'claimed' }],
    });

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg(),
    });
    expect(result).toMatchObject({ route: 'duplicate', reason: 'lease_held_elsewhere' });
    expect(mocks.callRpcSingle).not.toHaveBeenCalled();
  });

  it('unknown sender performs no owner action', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    vi.stubGlobal('fetch', fetchMock);
    const result = await resolveCanonicalOwner({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg({ from: '971599999999' }),
    });
    expect(result).toMatchObject({ isOwner: false, routingEnabled: true, reason: 'not_owner' });
  });

  it('ambiguous Boss candidates perform no owner action', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock, [owner, { ...owner, id: 'boss-2' }]);
    vi.stubGlobal('fetch', fetchMock);
    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg(),
    });
    expect(result).toEqual({
      isOwner: true,
      handled: false,
      route: 'identity_ambiguous',
      reason: 'canonical_owner_not_unique',
    });
    expect(mocks.callRpcRows).not.toHaveBeenCalled();
  });

  it('default-off flag preserves the existing downstream routing behavior', async () => {
    delete process.env.OWNER_WHATSAPP_ROUTING_USER_IDS;
    const fetchMock = vi.fn().mockResolvedValueOnce(response([{ user_id: 'user-1' }]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg(),
    });
    expect(result).toMatchObject({
      isOwner: false, routingEnabled: false, userId: 'user-1', reason: 'routing_disabled',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.callRpcRows).not.toHaveBeenCalled();
  });

  it('identity storage failure fails closed and never reaches consent/staff routing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: vi.fn() }));
    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg(),
    });
    expect(result).toEqual({
      isOwner: true,
      handled: false,
      route: 'identity_error',
      reason: 'identity_lookup_failed',
    });
    expect(mocks.callRpcRows).not.toHaveBeenCalled();
  });
});

describe('durable owner-decision disambiguation', () => {
  const candidates = [
    {
      decision_id: '11111111-1111-4111-8111-111111111111',
      staff_message_id: 'staff-new',
      created_at: '2026-07-28T21:51:38.255Z',
      inbound_text: 'Can I buy a small bouquet of flowers for the dining table tonight?',
    },
    {
      decision_id: '22222222-2222-4222-8222-222222222222',
      staff_message_id: 'staff-old',
      created_at: '2026-07-28T21:18:16.341Z',
      inbound_text: 'Can I buy two bottles of sparkling water for tonight?',
    },
  ];

  it.each([
    ['the first one', candidates[0]],
    ['The second one.', candidates[1]],
    ['the latest one', candidates[0]],
    ['the earlier one', candidates[1]],
    ['the one from 00:51', candidates[0]],
    ['the bouquet one', candidates[0]],
    ['the sparkling-water one', candidates[1]],
  ])('selects %s deterministically', (selector, expected) => {
    expect(isDisambiguationSelectorMessage(selector)).toBe(true);
    expect(selectDisambiguationCandidate(selector, candidates)).toBe(expected);
  });

  it('keeps a still-ambiguous description unresolved', () => {
    const sameTopic = [
      candidates[0],
      { ...candidates[1], inbound_text: candidates[0].inbound_text },
    ];
    expect(selectDisambiguationCandidate('the bouquet one', sameTopic)).toBeNull();
  });

  it('applies the preserved original answer to the selected decision, never the selector text', async () => {
    const clarification = {
      id: 'clarification-receipt',
      created_at: '2026-07-28T21:53:29.918Z',
      execution_result: {
        command_type: 'owner_decision',
        match_method: 'ambiguous',
        clarification_status: 'pending',
        original_answer: 'Yes he can buy the bouquet',
        expires_at: '2099-07-28T22:03:29.918Z',
        candidates,
      },
    };
    const selectedDecision = {
      id: candidates[1].decision_id,
      user_id: 'user-1',
      staff_message_id: candidates[1].staff_message_id,
      status: 'open',
      owner_reply_text: null,
      deep_link_token: 'deep-link-2',
      created_at: candidates[1].created_at,
    };
    const selectedStaffMessage = {
      id: candidates[1].staff_message_id,
      user_id: 'user-1',
      staff_name: 'Christopher',
      staff_phone: '+12025550123',
      inbound_text: candidates[1].inbound_text,
      owner_notification_status: 'sent',
    };
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock
      .mockResolvedValueOnce(response([clarification]))
      .mockResolvedValueOnce(response([{ ...clarification, execution_result: {
        ...clarification.execution_result,
        clarification_status: 'claimed',
        selector_receipt_id: claim.receipt_id,
      } }]))
      .mockResolvedValueOnce(response([selectedDecision]))
      .mockResolvedValueOnce(response([selectedStaffMessage]))
      .mockResolvedValueOnce(response([{ execution_result: {
        ...clarification.execution_result,
        clarification_status: 'claimed',
        selector_receipt_id: claim.receipt_id,
      } }]))
      .mockResolvedValueOnce(response([{}]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.resolve.mockResolvedValue({
      kind: 'success',
      status: 'delivered',
      ownerReplyText: 'Yes he can buy the bouquet',
      transportMessageId: 'wamid.staff-answer',
    });

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({ body: 'The second one' }),
    });

    expect(result).toMatchObject({
      handled: true,
      route: 'quoted_escalation',
      reason: 'resolved_escalation',
    });
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      escalation: expect.objectContaining({ id: candidates[1].decision_id }),
      decision: 'custom_instruction',
      instructionText: 'Yes he can buy the bouquet',
      replyChannel: 'whatsapp',
    }));
    expect(mocks.resolve).not.toHaveBeenCalledWith(expect.objectContaining({
      instructionText: 'The second one',
    }));
    const decisionLookup = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/staff_escalation_owner_decisions?'));
    expect(String(decisionLookup?.[0])).toContain(`id=eq.${candidates[1].decision_id}`);
    expect(String(decisionLookup?.[0])).not.toContain(candidates[0].decision_id);
    expect(mocks.updateCommand).toHaveBeenCalledWith(
      SUPABASE,
      KEY,
      claim,
      'user-1',
      expect.objectContaining({
        execution_result: expect.objectContaining({
          exact_reply: 'Yes he can buy the bouquet',
          selector_text: 'The second one',
        }),
      }),
    );
  });

  it('fails an expired selector truthfully without entering unsupported-command routing', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock.mockResolvedValueOnce(response([{
      id: 'expired-clarification',
      created_at: '2026-07-28T20:00:00.000Z',
      execution_result: {
        match_method: 'ambiguous',
        clarification_status: 'pending',
        original_answer: 'Yes',
        expires_at: '2026-07-28T20:10:00.000Z',
        candidates,
      },
    }]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({ body: 'The second one' }),
    });

    expect(result).toMatchObject({
      handled: true,
      route: 'owner_decision_disambiguation',
      reason: 'disambiguation_expired',
    });
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.sendMetaMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        text: { body: expect.stringContaining('clarification has expired') },
      }),
    }));
  });

  it('a repeated selector after resolution never delivers or falls into unsupported-command routing', async () => {
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock.mockResolvedValueOnce(response([{
      id: 'resolved-clarification',
      created_at: '2026-07-28T21:53:29.918Z',
      execution_result: {
        match_method: 'ambiguous',
        clarification_status: 'resolved',
        original_answer: 'Yes he can buy the bouquet',
        expires_at: '2099-07-28T22:03:29.918Z',
        selected_decision_id: candidates[1].decision_id,
        candidates,
      },
    }]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({ body: 'The second one' }),
    });

    expect(result).toMatchObject({
      handled: true,
      route: 'owner_decision_disambiguation',
      reason: 'disambiguation_already_resolved',
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.sendMetaMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        text: { body: expect.stringContaining('did not send another answer') },
      }),
    }));
  });

  it('does not resend an already accepted disambiguation acknowledgement during webhook replay', async () => {
    const acknowledgement = 'That decision clarification is already being handled. I did not send another answer.';
    const fetchMock = vi.fn();
    stubIdentity(fetchMock);
    fetchMock.mockResolvedValueOnce(response([{
      id: 'resolved-clarification',
      created_at: '2026-07-28T21:53:29.918Z',
      execution_result: {
        match_method: 'ambiguous',
        clarification_status: 'resolved',
        original_answer: 'Yes he can buy the bouquet',
        expires_at: '2099-07-28T22:03:29.918Z',
        selected_decision_id: candidates[1].decision_id,
        candidates,
      },
    }]));
    vi.stubGlobal('fetch', fetchMock);
    stubClaim();
    mocks.recordInbound.mockResolvedValue({
      data: {
        acknowledgement_status: 'accepted',
        acknowledgement_text: acknowledgement,
      },
      error: null,
    });

    const result = await handleInboundOwnerMessage({
      supabaseUrl: SUPABASE,
      serviceKey: KEY,
      msg: msg({ body: 'The second one' }),
    });

    expect(result).toMatchObject({
      handled: true,
      route: 'owner_decision_disambiguation',
      reason: 'disambiguation_already_resolved',
    });
    expect(mocks.sendMetaMessage).not.toHaveBeenCalled();
    expect(mocks.updateCommand).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });
});

describe('channel and webhook ordering guards', () => {
  it('app caller explicitly records app and WhatsApp caller explicitly records whatsapp', async () => {
    const fs = await import('node:fs/promises');
    const taskConfirm = await fs.readFile(new URL('./task-confirm.js', import.meta.url), 'utf8');
    const routing = await fs.readFile(new URL('./_owner-whatsapp-routing.js', import.meta.url), 'utf8');
    expect(taskConfirm).toContain("replyChannel: 'app'");
    expect(routing).toContain("replyChannel: 'whatsapp'");
    expect(taskConfirm).toContain('p_owner_reply_channel: replyChannel');
  });

  it('owner routing precedes consent handling', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./whatsapp-webhook.js', import.meta.url), 'utf8'));
    const ownerIndex = source.indexOf('await handleInboundOwnerMessage');
    const consentIndex = source.indexOf('await handleInboundConsentReply', ownerIndex);
    expect(ownerIndex).toBeGreaterThan(-1);
    expect(consentIndex).toBeGreaterThan(ownerIndex);
  });
});
