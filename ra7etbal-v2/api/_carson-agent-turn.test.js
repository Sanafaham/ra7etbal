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

// Routes fetch calls to get-signed-url vs. the conversation details
// endpoint by URL, so a single mock can serve both without per-test
// call-order assumptions. detailsResponses are served in order, one per
// call; the last entry repeats for any calls beyond the array length.
function makeFetchRouter({ signedUrl = 'wss://fake', detailsResponses = [] } = {}) {
  let detailsCallIndex = 0;
  return vi.fn(async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('get-signed-url')) {
      return { ok: true, json: async () => ({ signed_url: signedUrl }) };
    }
    if (urlStr.includes('/convai/conversations/')) {
      const resp = detailsResponses[Math.min(detailsCallIndex, detailsResponses.length - 1)];
      detailsCallIndex++;
      if (resp?.httpError) {
        return { ok: false, status: resp.httpError };
      }
      return { ok: true, json: async () => resp };
    }
    return { ok: true, json: async () => ({}) };
  });
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

describe('attemptCarsonBridgePoc — conversation_initiation_client_data wire shape', () => {
  it('the first serialized WebSocket message is exactly the required text-only + no-tools init payload', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: 'wss://fake' }),
    }));
    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p16', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });

    attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg: makeMsg(), findPersonByPhone });

    const socket = await waitForSocket();
    socket.emit('open');

    // socket.sent[0] is FakeWebSocket's JSON.parse(data) of what send()
    // actually received — i.e. the real serialized wire content, not the
    // pre-serialization JS object, so this rules out any JSON.stringify
    // data loss as well as a wrong-key/wrong-nesting/camelCase mistake.
    const initMessage = socket.sent[0];

    expect(initMessage.type).toBe('conversation_initiation_client_data');
    expect(initMessage.conversation_config_override.conversation.text_only).toBe(true);
    expect(initMessage.conversation_config_override.agent.prompt.tool_ids).toEqual([]);

    // No camelCase or duplicate/shadow field anywhere in the message that
    // could confuse a differently-implemented server-side parser.
    expect(initMessage).not.toHaveProperty('conversation_config_override.conversation.textOnly');
    expect(initMessage).not.toHaveProperty('textOnly');
    expect(initMessage).not.toHaveProperty('text_only');
    expect(initMessage.conversation_config_override.conversation).not.toHaveProperty('textOnly');

    // Exact full shape — an exhaustive match, not a partial toMatchObject,
    // so an accidental extra sibling key would also fail this test.
    expect(initMessage).toEqual({
      type: 'conversation_initiation_client_data',
      conversation_config_override: {
        conversation: { text_only: true },
        agent: { prompt: { tool_ids: [] } },
      },
    });
  });
});

describe('attemptCarsonBridgePoc — signed-URL branch resolution', () => {
  it('requests the signed URL with the correct agent_id and exactly one branch_id parameter', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: 'wss://fake' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p17', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });

    attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg: makeMsg(), findPersonByPhone });

    await waitForSocket();

    const signedUrlCall = fetchMock.mock.calls.find(([url]) => String(url).includes('get-signed-url'));
    expect(signedUrlCall).toBeDefined();
    const requestedUrl = new URL(String(signedUrlCall[0]));

    expect(requestedUrl.searchParams.get('agent_id')).toBe('agent_test123');
    expect(requestedUrl.searchParams.get('branch_id')).toBe('agtbrch_9201kt3zzm87evb92dt1bx1h4ayt');
    expect(requestedUrl.searchParams.getAll('branch_id')).toHaveLength(1);
    expect(signedUrlCall[1]).toEqual({ headers: { 'xi-api-key': 'test-key' } });
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

describe('attemptCarsonBridgePoc — conversation details lookup on premature close', () => {
  it('extracts conversation_id from conversation_initiation_metadata_event and uses it in the details lookup URL', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = makeFetchRouter({
      detailsResponses: [{ conversation_id: 'conv_abc123', status: 'done', metadata: {} }],
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p11', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });
    const msg = makeMsg();
    const resultPromise = attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone });

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_initiation_metadata',
        conversation_initiation_metadata_event: { conversation_id: 'conv_abc123' },
      }),
    });
    socket.emit('close', { code: 1000, reason: '' });
    await resultPromise;

    const detailsCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/convai/conversations/'));
    expect(detailsCall[0]).toBe('https://api.elevenlabs.io/v1/convai/conversations/conv_abc123');
    expect(detailsCall[1]).toEqual({ headers: { 'xi-api-key': 'test-key' } });
  });

  it('never calls the conversation details API when the turn completes successfully', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = makeFetchRouter();
    vi.stubGlobal('fetch', fetchMock);

    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p12', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });
    const msg = makeMsg();
    const resultPromise = attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone });

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_initiation_metadata',
        conversation_initiation_metadata_event: { conversation_id: 'conv_success' },
      }),
    });
    socket.emit('message', { data: JSON.stringify({ type: 'agent_response', text: 'On it.' }) });
    await resultPromise;

    const detailsCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/convai/conversations/'));
    expect(detailsCall).toBeUndefined();
  });

  it('does not perform a details lookup if close fires after the turn already succeeded', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = makeFetchRouter();
    vi.stubGlobal('fetch', fetchMock);

    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p13', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });
    const msg = makeMsg();
    const resultPromise = attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone });

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_initiation_metadata',
        conversation_initiation_metadata_event: { conversation_id: 'conv_late_close' },
      }),
    });
    socket.emit('message', { data: JSON.stringify({ type: 'agent_response', text: 'On it.' }) });
    await resultPromise;

    // Simulates the real WebSocket eventually firing 'close' after our own
    // finish()-triggered socket.close() call on a successful turn — proves
    // the settled guard, not just that FakeWebSocket.close() is a no-op.
    socket.emit('close', { code: 1000, reason: '' });
    await new Promise((r) => setTimeout(r, 0));

    const detailsCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/convai/conversations/'));
    expect(detailsCall).toBeUndefined();
  });

  it('logs only safe classification fields from the conversation details response, never transcript text or sensitive content', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const sensitiveTranscriptMessage = 'Grace said the WiFi password is hunter2';
    const fetchMock = makeFetchRouter({
      detailsResponses: [{
        conversation_id: 'conv_safe_test',
        agent_id: 'agent_test123',
        status: 'done',
        transcript: [
          { role: 'user', time_in_call_secs: 1, message: sensitiveTranscriptMessage },
          { role: 'agent', time_in_call_secs: 2, message: 'Some agent reply text' },
        ],
        metadata: {
          termination_reason: 'client disconnected',
          text_only: true,
          authorization_method: 'signed_url',
          error: null,
          main_language: 'en',
          dynamic_variables: { person_name: 'Grace', person_phone: '971501234567' },
        },
        version_id: 'v1',
        branch_id: 'main',
      }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p14', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });
    const msg = makeMsg({ body: 'staff message text' });
    const resultPromise = attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone });

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_initiation_metadata',
        conversation_initiation_metadata_event: { conversation_id: 'conv_safe_test' },
      }),
    });
    socket.emit('close', { code: 1000, reason: '' });
    await resultPromise;

    const detailsLog = consoleLog.mock.calls.find(([label]) => label === 'Carson bridge PoC: conversation details');
    expect(detailsLog).toBeDefined();
    expect(detailsLog[1]).toEqual({
      messageId: msg.messageId,
      conversationId: 'conv_safe_test',
      status: 'done',
      terminationReason: 'client disconnected',
      hasUserTranscript: true,
      hasAgentTranscript: true,
      userTranscriptEntries: 1,
      agentTranscriptEntries: 1,
      textOnly: true,
      authorizationMethod: 'signed_url',
      versionId: 'v1',
      branchId: 'main',
      hasError: false,
    });

    for (const call of consoleLog.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(sensitiveTranscriptMessage);
      expect(serialized).not.toContain('Some agent reply text');
      expect(serialized).not.toContain('staff message text');
      expect(serialized).not.toContain(msg.from);
      expect(serialized).not.toContain('Grace');
      expect(serialized).not.toContain('household coordinator');
      expect(serialized).not.toContain('dynamic_variables');
      expect(serialized).not.toContain('person_phone');
    }
  });

  it('retries a "processing" conversation status a bounded number of times, then stops', async () => {
    stubElevenLabsEnv();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = makeFetchRouter({
      detailsResponses: [
        { conversation_id: 'conv_retry', status: 'processing', metadata: {} },
        { conversation_id: 'conv_retry', status: 'processing', metadata: {} },
        { conversation_id: 'conv_retry', status: 'processing', metadata: {} },
        { conversation_id: 'conv_retry', status: 'processing', metadata: {} }, // would only be hit if unbounded
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const findPersonByPhone = vi.fn().mockResolvedValue({
      id: 'p15', name: 'Grace', role: 'household coordinator', is_family: false, whatsapp_opted_in: true,
    });
    const msg = makeMsg();
    const resultPromise = attemptCarsonBridgePoc({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'key', msg, findPersonByPhone });

    const socket = await waitForSocket();
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_initiation_metadata',
        conversation_initiation_metadata_event: { conversation_id: 'conv_retry' },
      }),
    });
    socket.emit('close', { code: 1000, reason: '' });
    await resultPromise;

    const detailsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/convai/conversations/'));
    expect(detailsCalls).toHaveLength(3); // strict small bound — never a 4th attempt

    const detailsLog = consoleLog.mock.calls.find(([label]) => label === 'Carson bridge PoC: conversation details');
    expect(detailsLog[1].status).toBe('processing');
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
