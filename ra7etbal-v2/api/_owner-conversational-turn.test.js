/**
 * Tests for runOwnerConversationalTurn in _carson-agent-turn.js.
 *
 * Covers: successful turn, bridge timeout, reply delivery failure,
 * ElevenLabs config missing, context build failure (non-fatal),
 * null agent response (fallback text sent), tool policy respected,
 * receipt completed on success, receipt failed on error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  sendMetaMessage: vi.fn(),
  completeReceipt: vi.fn(),
  failReceipt: vi.fn(),
}));

vi.mock('./send-whatsapp-task.js', () => ({
  default: vi.fn(),
  sendMetaMessage: mocks.sendMetaMessage,
}));

import { runOwnerConversationalTurn } from './_carson-agent-turn.js';

// ── FakeWebSocket ─────────────────────────────────────────────────────────────

let capturedSockets = [];

class FakeWebSocket extends EventTarget {
  constructor(url) {
    super();
    this.url  = url;
    this.sent = [];
    capturedSockets.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() { this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' })); }
  emit(type, data) {
    const ev = type === 'message' ? Object.assign(new MessageEvent('message', { data: JSON.stringify(data) }), {})
      : type === 'open' ? new Event('open')
      : Object.assign(new Event(type), data ?? {});
    this.dispatchEvent(ev);
  }
}

async function waitForSocket() {
  for (let i = 0; i < 20; i++) {
    if (capturedSockets.length > 0) return capturedSockets[capturedSockets.length - 1];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no socket captured');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SUPABASE = 'https://example.supabase.co';
const KEY      = 'service-key';

function identity(overrides = {}) {
  return { userId: 'user-1', ownerPhone: '+971501234567', ...overrides };
}

function makeMsg(overrides = {}) {
  return {
    body: 'Hi Carson',
    messageId: 'wamid.owner-1',
    phoneNumberId: 'meta-phone-1',
    ...overrides,
  };
}

function makeReceipt(overrides = {}) {
  return { receipt_id: 'receipt-1', claim_token: 'claim-1', status: 'claimed', ...overrides };
}

function stubFetch(supabase = false) {
  const signed = new Response(JSON.stringify({ signed_url: 'wss://agent.elevenlabs.io/signed' }), { status: 200 });
  const rows   = supabase ? new Response(JSON.stringify([]), { status: 200 }) : null;

  return vi.fn((url) => {
    if (url.includes('get-signed-url')) return Promise.resolve(signed.clone());
    if (rows && String(url).includes(SUPABASE)) return Promise.resolve(rows.clone());
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

function stubElevenLabsEnv() {
  process.env.ELEVENLABS_API_KEY       = 'xi-key';
  process.env.VITE_ELEVENLABS_AGENT_ID = 'agent_test123';
  process.env.WHATSAPP_ACCESS_TOKEN    = 'wa-test-token';
}

// sendMetaMessage is now called with an object { url, accessToken, payload }.
// Extract the WhatsApp message body from a sendMetaMessage call.
function getSentBody(callIndex = 0) {
  return mocks.sendMetaMessage.mock.calls[callIndex]?.[0]?.payload?.text?.body ?? null;
}

function baseParams(overrides = {}) {
  return {
    supabaseUrl: SUPABASE,
    serviceKey:  KEY,
    identity:    identity(),
    msg:         makeMsg(),
    receipt:     makeReceipt(),
    completeReceipt: mocks.completeReceipt,
    failReceipt:     mocks.failReceipt,
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  capturedSockets = [];
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.VITE_ELEVENLABS_AGENT_ID;
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  mocks.sendMetaMessage.mockReset();
  mocks.completeReceipt.mockReset();
  mocks.failReceipt.mockReset();
  mocks.sendMetaMessage.mockResolvedValue({ ok: true, messageId: 'wamid.reply-1' });
  mocks.completeReceipt.mockResolvedValue(true);
  mocks.failReceipt.mockResolvedValue(undefined);
});

// ── Missing ElevenLabs config ─────────────────────────────────────────────────

describe('runOwnerConversationalTurn — missing config', () => {
  it('returns handled:false and fails receipt when env vars missing', async () => {
    vi.stubGlobal('fetch', stubFetch(true));
    const result = await runOwnerConversationalTurn(baseParams());
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('missing_config');
    expect(mocks.failReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.sendMetaMessage).not.toHaveBeenCalled();
  });
});

// ── Successful turn ───────────────────────────────────────────────────────────

describe('runOwnerConversationalTurn — successful turn', () => {
  it('sends reply, completes receipt, returns handled:true', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', stubFetch(true));

    const params        = baseParams({ msg: makeMsg({ body: 'What is pending?' }) });
    const resultPromise = runOwnerConversationalTurn(params);

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', {
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'conv-owner-1' },
    });
    socket.emit('message', {
      type: 'agent_response',
      agent_response_event: { agent_response: 'You have 3 pending delegations.' },
    });

    const result = await resultPromise;

    expect(result.handled).toBe(true);
    expect(result.route).toBe('owner_conversational');
    expect(result.reason).toBe('answered');

    expect(mocks.sendMetaMessage).toHaveBeenCalledTimes(1);
    expect(getSentBody()).toBe('You have 3 pending delegations.');
    expect(mocks.sendMetaMessage.mock.calls[0][0].payload.to).toBe('+971501234567');
    expect(mocks.completeReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.completeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'conversational_turn',
    }));
    expect(mocks.failReceipt).not.toHaveBeenCalled();
  });

  it('sends user_message with the owner body text', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', stubFetch(true));

    const body          = 'Did Ahmed reply yet?';
    const resultPromise = runOwnerConversationalTurn(baseParams({ msg: makeMsg({ body }) }));

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', {
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'conv-owner-2' },
    });
    socket.emit('message', {
      type: 'agent_response',
      agent_response_event: { agent_response: "Ahmed hasn't replied yet." },
    });

    await resultPromise;

    const userMsg = socket.sent.find((m) => m.type === 'user_message');
    expect(userMsg).toBeDefined();
    expect(userMsg.text).toBe(body);
  });

  it('sends tool policy in conversation_initiation_client_data', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', stubFetch(true));

    const toolPolicy    = { tool_ids: [] };
    const resultPromise = runOwnerConversationalTurn(baseParams({ toolPolicy }));

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', {
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'conv-owner-3' },
    });
    socket.emit('message', {
      type: 'agent_response',
      agent_response_event: { agent_response: 'Hello!' },
    });

    await resultPromise;

    const initMsg = socket.sent.find((m) => m.type === 'conversation_initiation_client_data');
    expect(initMsg).toBeDefined();
    expect(initMsg.conversation_config_override.agent.prompt.tool_ids).toEqual([]);
    expect(initMsg.conversation_config_override.conversation.text_only).toBe(true);
  });
});

// ── Null agent response — fallback ────────────────────────────────────────────

describe('runOwnerConversationalTurn — null agent response uses fallback', () => {
  it('sends fallback text when agent_response is null', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', stubFetch(true));

    const resultPromise = runOwnerConversationalTurn(baseParams());

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', {
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'conv-null' },
    });
    socket.emit('message', {
      type: 'agent_response',
      agent_response_event: { agent_response: null },
    });

    const result = await resultPromise;

    expect(result.handled).toBe(true);
    expect(getSentBody()).toContain('try again');
    expect(mocks.completeReceipt).toHaveBeenCalledTimes(1);
  });
});

// ── Reply delivery failure ────────────────────────────────────────────────────

describe('runOwnerConversationalTurn — reply delivery failure', () => {
  it('fails receipt and returns handled:false when sendMetaMessage fails', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', stubFetch(true));
    mocks.sendMetaMessage.mockResolvedValue({ ok: false, reason: 'meta_error' });

    const resultPromise = runOwnerConversationalTurn(baseParams());

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', {
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'conv-fail' },
    });
    socket.emit('message', {
      type: 'agent_response',
      agent_response_event: { agent_response: 'Some reply' },
    });

    const result = await resultPromise;

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('reply_delivery_failed');
    expect(mocks.failReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.completeReceipt).not.toHaveBeenCalled();
  });
});

// ── Bridge turn error — sends fallback ───────────────────────────────────────

describe('runOwnerConversationalTurn — ElevenLabs bridge error', () => {
  it('fails receipt, sends fallback WhatsApp message, returns handled:false on turn error', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('elevenlabs_unreachable')));

    const result = await runOwnerConversationalTurn(baseParams());

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('turn_failed');
    expect(mocks.failReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.sendMetaMessage).toHaveBeenCalledTimes(1);
    expect(getSentBody()).toContain('try again');
  });
});

// ── Context build failure — non-fatal ────────────────────────────────────────

describe('runOwnerConversationalTurn — context build failure is non-fatal', () => {
  it('proceeds without context when Supabase context fetch fails', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const fetchMock = vi.fn((url) => {
      if (url.includes('get-signed-url')) {
        return Promise.resolve(new Response(
          JSON.stringify({ signed_url: 'wss://agent.elevenlabs.io/signed' }), { status: 200 }
        ));
      }
      // Supabase context queries fail
      return Promise.resolve(new Response('[]', { status: 500, ok: false }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = runOwnerConversationalTurn(baseParams());

    const socket = await waitForSocket();
    socket.emit('open');

    const initMsg = socket.sent.find((m) => m.type === 'conversation_initiation_client_data');
    // Proceeds even when context is unavailable
    expect(initMsg).toBeDefined();

    socket.emit('message', {
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'conv-no-ctx' },
    });
    socket.emit('message', {
      type: 'agent_response',
      agent_response_event: { agent_response: 'Hello!' },
    });

    const result = await resultPromise;
    expect(result.handled).toBe(true);
  });
});

// ── Action tools are blocked by default policy ────────────────────────────────

describe('runOwnerConversationalTurn — default tool policy blocks action tools', () => {
  it('default policy sends tool_ids: [] blocking all action tools', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', stubFetch(true));

    const resultPromise = runOwnerConversationalTurn(baseParams());

    const socket = await waitForSocket();
    socket.emit('open');

    const initMsg = socket.sent.find((m) => m.type === 'conversation_initiation_client_data');
    expect(initMsg.conversation_config_override.agent.prompt.tool_ids).toEqual([]);

    socket.emit('message', {
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'conv-policy' },
    });
    socket.emit('message', {
      type: 'agent_response',
      agent_response_event: { agent_response: 'Reply text.' },
    });

    await resultPromise;
  });

  it('custom toolPolicy is forwarded to ElevenLabs', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', stubFetch(true));

    const customPolicy  = { tool_ids: ['create_reminder'] };
    const resultPromise = runOwnerConversationalTurn(baseParams({ toolPolicy: customPolicy }));

    const socket = await waitForSocket();
    socket.emit('open');

    const initMsg = socket.sent.find((m) => m.type === 'conversation_initiation_client_data');
    expect(initMsg.conversation_config_override.agent.prompt.tool_ids).toEqual(['create_reminder']);

    socket.emit('message', {
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'conv-custom-policy' },
    });
    socket.emit('message', {
      type: 'agent_response',
      agent_response_event: { agent_response: 'Done.' },
    });

    await resultPromise;
  });
});
