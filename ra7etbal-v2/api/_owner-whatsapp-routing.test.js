import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callRpcRows: vi.fn(),
  callRpcSingle: vi.fn(),
  resolve: vi.fn(),
  sendMetaMessage: vi.fn(),
  executeCommand: vi.fn(),
  recordInbound: vi.fn(),
  updateCommand: vi.fn(),
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

import {
  handleInboundOwnerMessage,
  resolveCanonicalOwner,
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
});

describe('general owner command safety', () => {
  for (const [label, body] of [
    ['one escalation exists', 'Remind me to pay the electricity bill tomorrow.'],
    ['multiple escalations exist', 'Tell Christopher to make pizza.'],
    ['zero escalations exist', 'What still needs my attention?'],
  ]) {
    it(`${label}: enters the general path without reading or resolving escalations`, async () => {
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
      expect(mocks.sendMetaMessage).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).includes('staff_escalation_owner_decisions'))).toBe(false);
      expect(mocks.callRpcSingle).toHaveBeenCalledWith(
        SUPABASE, KEY, 'complete_owner_whatsapp_reply',
        expect.objectContaining({ p_outcome: 'general_command_executed', p_escalation_id: null }),
      );
    });
  }

  it('contains no open-count inference implementation', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./_owner-whatsapp-routing.js', import.meta.url), 'utf8'));
    expect(source).not.toContain('status=eq.open');
    expect(source).not.toContain('fetchOpenEscalations');
    expect(source).not.toMatch(/openRows|openEscalations|open_escalation_count/i);
    expect(source).not.toMatch(/staff_escalation_owner_decisions[^`]*status=eq\.open/i);
  });
});

describe('authoritative quoted escalation routing', () => {
  function stubQuoted(fetchMock, escalationStatus = 'open') {
    stubIdentity(fetchMock);
    fetchMock
      .mockResolvedValueOnce(response([{ metadata: { escalation_id: 'esc-2' } }]))
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

  it('valid quote with multiple unrelated open escalations resolves only the referenced escalation', async () => {
    const fetchMock = vi.fn();
    stubQuoted(fetchMock);
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
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('status=eq.open'))).toBe(false);
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

  it('already-resolved quoted escalation delegates to idempotent Phase D and never supplies a new channel-less answer', async () => {
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

    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      escalation: expect.objectContaining({ status: 'delivered_to_staff' }),
      replyChannel: 'whatsapp',
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
