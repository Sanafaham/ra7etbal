/**
 * Slice 1 — an owner WhatsApp reply to a 'no_response' handoff must never
 * enter the approve / reject / custom-instruction path and must never send
 * anything to staff. It fails closed with a truthful pointer to the link.
 * Harness mirrors _owner-whatsapp-routing.test.js.
 */
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
  buildDirectMessagePayload: vi.fn(),
  normalizeWhatsAppPhone: vi.fn((p) => p),
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

const { handleInboundOwnerMessage, NO_RESPONSE_WHATSAPP_REPLY_TEXT } = await import('./_owner-whatsapp-routing.js');

const SUPABASE = 'https://example.supabase.co';
const KEY = 'service-key';
const owner = { id: 'boss-1', name: 'Sana', role: 'boss', phone: '+971501234567' };

function response(data, ok = true) {
  return { ok, json: vi.fn().mockResolvedValue(data) };
}

function msg(overrides = {}) {
  return {
    from: '971501234567',
    messageId: 'wamid.in-nr',
    body: 'Yes',
    phoneNumberId: 'meta-phone-1',
    contextMessageId: 'wamid.owner-no-response',
    ...overrides,
  };
}

const NO_RESPONSE_DECISION = {
  id: 'esc-nr',
  user_id: 'user-1',
  staff_message_id: null,
  task_id: 'task-1',
  review_type: 'no_response',
  status: 'open',
  owner_reply_text: null,
  deep_link_token: 'deep-nr',
  owner_notified_at: '2026-09-28T17:00:00Z',
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env.WHATSAPP_ACCESS_TOKEN = 'token';
  process.env.OWNER_WHATSAPP_ROUTING_USER_IDS = 'user-1';
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.callRpcRows.mockResolvedValue({ data: [{ receipt_id: 'r-1', claimed: true, claim_token: 'c-1', status: 'claimed' }] });
  mocks.callRpcSingle.mockResolvedValue({ data: { status: 'completed' } });
  mocks.sendMetaMessage.mockResolvedValue({ ok: true, messageId: 'wamid.ack' });
  mocks.recordInbound.mockResolvedValue({ data: { acknowledgement_status: 'pending' }, error: null });
  mocks.updateCommand.mockResolvedValue({});
});

function stubQuotedNoResponse(fetchMock) {
  fetchMock
    .mockResolvedValueOnce(response([{ user_id: 'user-1' }]))
    .mockResolvedValueOnce(response([owner]))
    .mockResolvedValueOnce(response([{
      metadata: { escalation_id: 'esc-nr', owner_phone_number_id: 'meta-phone-1', review_type: 'no_response' },
      recipient_phone: owner.phone,
      delivery_status: 'delivered',
    }]))
    .mockResolvedValueOnce(response([NO_RESPONSE_DECISION]));
}

describe('owner WhatsApp reply to a no_response handoff', () => {
  it.each(['Yes', 'No', 'approve', 'ask him again', 'keep waiting', 'Ask again'])(
    'reply %j never resolves, never delivers to staff, and points to the decision page',
    async (body) => {
      const fetchMock = vi.fn();
      stubQuotedNoResponse(fetchMock);
      vi.stubGlobal('fetch', fetchMock);

      const result = await handleInboundOwnerMessage({ supabaseUrl: SUPABASE, serviceKey: KEY, msg: msg({ body }) });

      expect(result).toMatchObject({ isOwner: true, handled: true, route: 'no_response_handoff', reason: 'decision_page_required' });
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(mocks.executeCommand).not.toHaveBeenCalled();
      expect(mocks.ownerConversationalTurn).not.toHaveBeenCalled();
      // Exactly one message, to the owner, with the truthful pointer.
      expect(mocks.sendMetaMessage).toHaveBeenCalledTimes(1);
      const sent = JSON.stringify(mocks.sendMetaMessage.mock.calls[0][0]);
      expect(sent).toContain(owner.phone.replace('+', ''));
      expect(sent).toContain('nothing was sent');
      // No answer RPC, no delivery claim.
      const rpcNames = mocks.callRpcSingle.mock.calls.map((c) => c[2]);
      expect(rpcNames).not.toContain('answer_escalation_owner_decision');
      expect(rpcNames).not.toContain('claim_escalation_answer_delivery');
    },
  );

  it('the pointer text makes no claim that anything happened', () => {
    expect(NO_RESPONSE_WHATSAPP_REPLY_TEXT).toMatch(/haven't acted on that reply and nothing was sent/);
    expect(NO_RESPONSE_WHATSAPP_REPLY_TEXT).toMatch(/Ask again or Keep waiting/);
  });
});
