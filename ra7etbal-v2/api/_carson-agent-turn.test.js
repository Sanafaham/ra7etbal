import { afterEach, describe, expect, it, vi } from 'vitest';

import { attemptCarsonBridgePoc } from './_carson-agent-turn.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  FakeWebSocket.instances = [];
});

function stubElevenLabsEnv() {
  vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
  vi.stubEnv('VITE_ELEVENLABS_AGENT_ID', 'agent_test123');
}

function makeMsg(overrides = {}) {
  return {
    from: '971501234567',
    messageId: `wamid.${Math.random().toString(36).slice(2)}`,
    body: 'We are out of strawberries. What should I do?',
    timestamp: '1700000000',
    ...overrides,
  };
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  emit(type, data) {
    for (const fn of this.listeners[type] || []) fn(data);
  }
}
FakeWebSocket.instances = [];

async function waitForSocket() {
  for (let i = 0; i < 50 && FakeWebSocket.instances.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

describe('attemptCarsonBridgePoc — staff identity gate', () => {
  it('ignores an unknown sender and never contacts Carson', async () => {
    stubElevenLabsEnv();
    const findPersonByPhone = vi.fn().mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await attemptCarsonBridgePoc({
      supabaseUrl: 'https://x.supabase.co',
      serviceKey: 'key',
      msg: makeMsg(),
      findPersonByPhone,
    });

    expect(result).toEqual({ handled: false, reason: 'unknown_sender', messageId: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled(); // no get-signed-url call was ever attempted
  });

  it('ignores a family member even if the phone matches, and never contacts Carson', async () => {
    stubElevenLabsEnv();
    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p1', name: 'Sana\'s Brother', role: 'family', is_family: true, whatsapp_opted_in: true,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await attemptCarsonBridgePoc({
      supabaseUrl: 'https://x.supabase.co',
      serviceKey: 'key',
      msg: makeMsg(),
      findPersonByPhone,
    });

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('rejected_family');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a matched staff member who has not opted in, and never contacts Carson', async () => {
    stubElevenLabsEnv();
    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p2', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: false,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await attemptCarsonBridgePoc({
      supabaseUrl: 'https://x.supabase.co',
      serviceKey: 'key',
      msg: makeMsg(),
      findPersonByPhone,
    });

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('rejected_unconsented');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports missing_config safely when ElevenLabs env vars are absent, without throwing', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '');
    vi.stubEnv('VITE_ELEVENLABS_AGENT_ID', '');
    const findPersonByPhone = vi.fn();

    const result = await attemptCarsonBridgePoc({
      supabaseUrl: 'https://x.supabase.co',
      serviceKey: 'key',
      msg: makeMsg(),
      findPersonByPhone,
    });

    expect(result).toEqual({ handled: false, reason: 'missing_config', messageId: expect.any(String) });
    // Identity is never even looked up if Carson can't be reached anyway.
    expect(findPersonByPhone).not.toHaveBeenCalled();
  });
});

describe('attemptCarsonBridgePoc — one valid staff message reaches the production Carson agent', () => {
  it('fetches a signed URL, opens a text-only turn, and captures one final agent response', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    vi.stubEnv('VITE_ELEVENLABS_AGENT_ID', 'agent_test123');
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: 'wss://api.elevenlabs.io/fake-signed-url' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p3', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });

    const msg = makeMsg({ body: 'We are out of strawberries. What should I do?' });
    const resultPromise = attemptCarsonBridgePoc({
      supabaseUrl: 'https://x.supabase.co',
      serviceKey: 'key',
      msg,
      findPersonByPhone,
    });

    const socket = await waitForSocket();
    expect(socket.url).toBe('wss://api.elevenlabs.io/fake-signed-url');

    socket.emit('open');
    expect(socket.sent[0]).toMatchObject({
      type: 'conversation_initiation_client_data',
      conversation_config_override: {
        conversation: { text_only: true },
        agent: { prompt: { tool_ids: [] } },
      },
    });

    socket.emit('message', { data: JSON.stringify({ type: 'conversation_initiation_metadata' }) });
    expect(socket.sent[1]).toMatchObject({ type: 'contextual_update' });
    expect(socket.sent[1].text).toContain('Grace');
    expect(socket.sent[2]).toEqual({ type: 'user_message', text: msg.body });

    socket.emit('message', {
      data: JSON.stringify({
        type: 'agent_response',
        agent_response_event: { agent_response: 'Buy more from the corner store, that is the usual routine.' },
      }),
    });

    const result = await resultPromise;
    expect(result).toEqual({ handled: true, reason: 'answered', messageId: msg.messageId });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('get-signed-url?agent_id=agent_test123'),
      expect.objectContaining({ headers: { 'xi-api-key': 'test-key' } }),
    );
  });

  it('replies with an error client_tool_result instead of stalling when Carson attempts a client-only tool', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    vi.stubEnv('VITE_ELEVENLABS_AGENT_ID', 'agent_test123');
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: 'wss://fake' }),
    }));

    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p4', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });

    const msg = makeMsg();
    const resultPromise = attemptCarsonBridgePoc({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone,
    });

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', { data: JSON.stringify({ type: 'conversation_initiation_metadata' }) });
    socket.emit('message', {
      data: JSON.stringify({
        type: 'client_tool_call',
        client_tool_call: { tool_name: 'create_todo', tool_call_id: 'call_abc' },
      }),
    });

    expect(socket.sent.at(-1)).toEqual({
      type: 'client_tool_result',
      tool_call_id: 'call_abc',
      result: 'Client tools are not available in this channel.',
      is_error: true,
      error_type: 'external_client',
    });

    // Conversation can still complete normally afterwards.
    socket.emit('message', {
      data: JSON.stringify({ type: 'agent_response', agent_response: 'Noted.' }),
    });
    await expect(resultPromise).resolves.toEqual({ handled: true, reason: 'answered', messageId: msg.messageId });
  });
});

describe('attemptCarsonBridgePoc — idempotency on the real Meta message id', () => {
  it('a duplicate message id is skipped without a second identity lookup or Carson call', async () => {
    stubElevenLabsEnv();
    const sharedId = `wamid.dup-${Math.random().toString(36).slice(2)}`;
    // First call resolves quickly as unknown_sender — idempotency only cares
    // that the id was claimed, not how the first attempt turned out.
    const findPersonByPhone = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn());

    const first = await attemptCarsonBridgePoc({
      supabaseUrl: 'https://x.supabase.co',
      serviceKey: 'key',
      msg: makeMsg({ messageId: sharedId }),
      findPersonByPhone,
    });
    expect(first.reason).toBe('unknown_sender');

    const second = await attemptCarsonBridgePoc({
      supabaseUrl: 'https://x.supabase.co',
      serviceKey: 'key',
      msg: makeMsg({ messageId: sharedId }),
      findPersonByPhone,
    });

    expect(second).toEqual({ handled: false, reason: 'duplicate_message_id', messageId: sharedId });
    expect(findPersonByPhone).toHaveBeenCalledTimes(1); // not called again for the retry
  });
});
