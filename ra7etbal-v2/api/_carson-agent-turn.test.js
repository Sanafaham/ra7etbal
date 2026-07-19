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
    expect(socket.sent[1]).toEqual({ type: 'user_message', text: msg.body });
    expect(socket.sent).toHaveLength(2); // exactly one message follows metadata

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

describe('attemptCarsonBridgePoc — WebSocket event sequencing', () => {
  it('never sends user_message before conversation_initiation_metadata is received', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: 'wss://fake' }),
    }));
    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p5', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });

    const msg = makeMsg();
    attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone });

    const socket = await waitForSocket();
    socket.emit('open');

    // Only conversation_initiation_client_data goes out on open — nothing
    // else, and specifically no user_message, until metadata arrives.
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0].type).toBe('conversation_initiation_client_data');
    expect(socket.sent.some((m) => m.type === 'user_message')).toBe(false);

    // A ping in between must not trigger a user_message either.
    socket.emit('message', { data: JSON.stringify({ type: 'ping', ping_event: { event_id: 1 } }) });
    expect(socket.sent.some((m) => m.type === 'user_message')).toBe(false);
  });

  it('sends user_message exactly once, immediately after metadata', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: 'wss://fake' }),
    }));
    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p6', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });

    const msg = makeMsg({ body: 'Can you check on the delivery?' });
    attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone });

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', { data: JSON.stringify({ type: 'conversation_initiation_metadata' }) });

    const userMessages = socket.sent.filter((m) => m.type === 'user_message');
    expect(userMessages).toEqual([{ type: 'user_message', text: msg.body }]);

    // A second, unrelated server event afterwards must not resend it.
    socket.emit('message', { data: JSON.stringify({ type: 'ping', ping_event: { event_id: 2 } }) });
    expect(socket.sent.filter((m) => m.type === 'user_message')).toHaveLength(1);
  });

  it('keeps the socket open after user_message — does not resolve or close while waiting for the agent response', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: 'wss://fake' }),
    }));
    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p7', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });

    const msg = makeMsg();
    let settled = false;
    const resultPromise = attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone })
      .then((r) => { settled = true; return r; });

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', { data: JSON.stringify({ type: 'conversation_initiation_metadata' }) });

    // Give any wrongly-premature resolution a chance to happen.
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    expect(socket.closeCalled).toBeUndefined();

    // Only now does the turn actually complete.
    socket.emit('message', { data: JSON.stringify({ type: 'agent_response', text: 'On it.' }) });
    await resultPromise;
    expect(settled).toBe(true);
  });

  it('a normal close (code 1000) before any agent response still fails diagnostically with the code, hasReason, and lastStep — never the raw reason', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: 'wss://fake' }),
    }));
    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p8', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const msg = makeMsg();
    const resultPromise = attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone });

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', { data: JSON.stringify({ type: 'conversation_initiation_metadata' }) });
    const sensitiveCloseReason = 'Override for field debug_secret_token_xyz is not allowed';
    socket.emit('close', { code: 1000, reason: sensitiveCloseReason });

    const result = await resultPromise;
    expect(result).toEqual({ handled: false, reason: 'error', messageId: msg.messageId });
    expect(consoleError).toHaveBeenCalledWith(
      'Carson bridge PoC: turn failed',
      expect.objectContaining({
        error: 'carson_turn_closed_before_response code=1000 hasReason=true lastStep=user_message_sent',
      }),
    );

    for (const call of consoleError.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(sensitiveCloseReason);
    }
  });
});

describe('attemptCarsonBridgePoc — diagnostic step logging', () => {
  it('logs the six confirmed steps in order, with only safe fields (messageId/type/step/code/hasReason)', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: 'wss://fake' }),
    }));
    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p9', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const msg = makeMsg({ body: 'Secret staff text that must never appear in logs' });
    const resultPromise = attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone });

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', { data: JSON.stringify({ type: 'conversation_initiation_metadata' }) });
    socket.emit('message', { data: JSON.stringify({ type: 'agent_response', text: 'On it.' }) });
    await resultPromise;

    const diagCalls = consoleLog.mock.calls.filter(([label]) => typeof label === 'string' && label.startsWith('Carson bridge PoC:'));
    const labels = diagCalls.map(([label]) => label);

    expect(labels).toEqual([
      'Carson bridge PoC: WS opened',
      'Carson bridge PoC: conversation_initiation_client_data sent',
      'Carson bridge PoC: conversation_initiation_metadata received',
      'Carson bridge PoC: user_message sent',
      'Carson bridge PoC: first event after user_message',
      'Carson bridge PoC: turn complete',
    ]);

    const firstEventAfterUserMessage = diagCalls.find(([label]) => label === 'Carson bridge PoC: first event after user_message');
    expect(firstEventAfterUserMessage[1]).toEqual({ messageId: msg.messageId, type: 'agent_response' });

    // No log call anywhere contains the staff message text, a phone number,
    // person name, person role, prompts, tokens, credentials, or a full
    // payload object.
    for (const call of consoleLog.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('Secret staff text');
      expect(serialized).not.toContain(msg.from);
      expect(serialized).not.toContain('Grace');
      expect(serialized).not.toContain('household coordinator');
    }
  });

  it('logs only "WS closed" with code/hasReason/lastStep (never the raw reason) when the server closes before any post-user_message event', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: 'wss://fake' }),
    }));
    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p10', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const msg = makeMsg();
    const resultPromise = attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone });

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', { data: JSON.stringify({ type: 'conversation_initiation_metadata' }) });
    // Reproduces the observed production failure (code 1000, no further
    // message event after user_message) with a non-empty, distinctive close
    // reason so the test can prove that raw text is never logged anywhere,
    // not just when the reason happens to be empty.
    const sensitiveCloseReason = 'Override for field debug_secret_token_xyz is not allowed';
    socket.emit('close', { code: 1000, reason: sensitiveCloseReason });
    await resultPromise;

    const diagCalls = consoleLog.mock.calls.filter(([label]) => typeof label === 'string' && label.startsWith('Carson bridge PoC:'));
    const labels = diagCalls.map(([label]) => label);

    expect(labels).toEqual([
      'Carson bridge PoC: WS opened',
      'Carson bridge PoC: conversation_initiation_client_data sent',
      'Carson bridge PoC: conversation_initiation_metadata received',
      'Carson bridge PoC: user_message sent',
      'Carson bridge PoC: WS closed',
    ]);
    // No "first event after user_message" — proves nothing came back at all.
    expect(labels).not.toContain('Carson bridge PoC: first event after user_message');

    const closeCall = diagCalls.find(([label]) => label === 'Carson bridge PoC: WS closed');
    expect(closeCall[1]).toEqual({
      messageId: msg.messageId,
      code: 1000,
      hasReason: true,
      lastStep: 'user_message_sent',
    });

    for (const call of consoleLog.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(sensitiveCloseReason);
    }
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
