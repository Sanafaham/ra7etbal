import { afterEach, describe, expect, it, vi } from 'vitest';

const taskConfirmMocks = vi.hoisted(() => ({
  findOwnerPhone: vi.fn(async () => '+971501234567'),
  resolveAndDeliverEscalationAnswer: vi.fn(async () => ({ kind: 'success', status: 'delivered', ownerReplyText: 'text' })),
  callRpcSingle: vi.fn(),
  callRpcRows: vi.fn(),
}));

const smsMocks = vi.hoisted(() => ({
  sendMetaMessage: vi.fn(async () => ({ ok: true, messageId: 'wamid.reply-1', metaError: null })),
}));

vi.mock('./task-confirm.js', () => ({
  findOwnerPhone: taskConfirmMocks.findOwnerPhone,
  resolveAndDeliverEscalationAnswer: taskConfirmMocks.resolveAndDeliverEscalationAnswer,
  callRpcSingle: taskConfirmMocks.callRpcSingle,
  callRpcRows: taskConfirmMocks.callRpcRows,
}));

vi.mock('./send-whatsapp-task.js', () => ({
  sendMetaMessage: smsMocks.sendMetaMessage,
}));

import { handleInboundOwnerReply } from './_owner-escalation-reply.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  taskConfirmMocks.findOwnerPhone.mockClear();
  taskConfirmMocks.resolveAndDeliverEscalationAnswer.mockClear();
  taskConfirmMocks.callRpcSingle.mockClear();
  taskConfirmMocks.callRpcRows.mockClear();
  smsMocks.sendMetaMessage.mockClear();
});

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) };
}

function stubEnv() {
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'meta-access-token');
}

function baseMsg(overrides = {}) {
  return {
    from: '971501234567',
    messageId: 'wamid.owner-in-1',
    body: 'Yes, go ahead and buy it.',
    phoneNumberId: 'meta-phone-id',
    timestamp: '1700000000',
    contextMessageId: null,
    ...overrides,
  };
}

const OPEN_ESCALATION = {
  id: 'escalation-1',
  user_id: 'user-1',
  staff_message_id: 'staff-message-1',
  status: 'open',
  owner_reply_text: null,
  deep_link_token: 'token-1',
};

const STAFF_MESSAGE = {
  id: 'staff-message-1',
  person_id: 'person-1',
  staff_name: 'Christopher',
  staff_phone: '+971509999999',
  inbound_text: 'Can I buy red wine vinegar instead?',
};

describe('handleInboundOwnerReply — sender identification', () => {
  it('a non-owner sender is never claimed and falls through untouched (isOwner:false)', async () => {
    stubEnv();
    taskConfirmMocks.findOwnerPhone.mockResolvedValueOnce('+971501234567');
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: baseMsg({ from: '971509999999' }), // not the owner's number
    });

    expect(result).toEqual({ isOwner: false, reason: 'not_owner' });
    expect(taskConfirmMocks.callRpcRows).not.toHaveBeenCalled();
  });

  it('an ambiguous household (0 or 2+ whatsapp_health_state rows) is never treated as the owner', async () => {
    stubEnv();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }, { user_id: 'user-2' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: baseMsg(),
    });

    expect(result).toEqual({ isOwner: false, reason: 'household_not_unique' });
    expect(taskConfirmMocks.findOwnerPhone).not.toHaveBeenCalled();
  });
});

describe('handleInboundOwnerReply — idempotency (receipt claim)', () => {
  it('an already-completed receipt (redelivered webhook) does nothing further — no correlation query, no send', async () => {
    stubEnv();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]));
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: false, claim_token: null, status: 'completed', outcome: 'resolved_escalation' }],
    });

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key', msg: baseMsg(),
    });

    expect(result).toEqual({ isOwner: true, handled: true, reason: 'already_completed' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the household lookup — no correlation queries
    expect(taskConfirmMocks.resolveAndDeliverEscalationAnswer).not.toHaveBeenCalled();
    expect(smsMocks.sendMetaMessage).not.toHaveBeenCalled();
  });

  it('a live lease held elsewhere (concurrent redelivery in flight) does nothing further', async () => {
    stubEnv();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]));
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: false, claim_token: null, status: 'claimed', outcome: null }],
    });

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key', msg: baseMsg(),
    });

    expect(result).toEqual({ isOwner: true, handled: true, reason: 'lease_held_elsewhere' });
    expect(taskConfirmMocks.resolveAndDeliverEscalationAnswer).not.toHaveBeenCalled();
    expect(smsMocks.sendMetaMessage).not.toHaveBeenCalled();
  });

  it('claims with the exact Meta inbound message id, scoped to the resolved user', async () => {
    stubEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([])); // open escalations: none
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: true, claim_token: 'claim-token-1', status: 'claimed', outcome: null }],
    });
    taskConfirmMocks.callRpcSingle.mockResolvedValueOnce({ data: { id: 'receipt-1', status: 'completed' } });

    await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: baseMsg({ messageId: 'wamid.owner-in-42' }),
    });

    expect(taskConfirmMocks.callRpcRows).toHaveBeenCalledWith(
      'https://x.supabase.co', 'service-key', 'claim_owner_whatsapp_reply',
      { p_user_id: 'user-1', p_external_message_id: 'wamid.owner-in-42', p_lease_seconds: 120 },
    );
  });
});

describe('handleInboundOwnerReply — correlation and resolution', () => {
  it('a quoted reply to the Phase B notification resolves that exact escalation regardless of other open escalations', async () => {
    stubEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }])) // whatsapp_health_state
      .mockResolvedValueOnce(jsonResponse([{ metadata: { escalation_id: 'escalation-1' } }])) // whatsapp_deliveries by meta_message_id
      .mockResolvedValueOnce(jsonResponse([OPEN_ESCALATION])) // staff_escalation_owner_decisions by id
      .mockResolvedValueOnce(jsonResponse([STAFF_MESSAGE])); // staff_messages
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: true, claim_token: 'claim-token-1', status: 'claimed', outcome: null }],
    });
    taskConfirmMocks.resolveAndDeliverEscalationAnswer.mockResolvedValueOnce({ kind: 'success', status: 'delivered', ownerReplyText: 'x' });
    taskConfirmMocks.callRpcSingle.mockResolvedValueOnce({ data: { id: 'receipt-1', status: 'completed' } });

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: baseMsg({ contextMessageId: 'wamid.notify-1', body: 'Yes, go ahead.' }),
    });

    expect(result).toEqual({ isOwner: true, handled: true, reason: 'resolved_escalation' });
    expect(taskConfirmMocks.resolveAndDeliverEscalationAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        deepLinkToken: 'token-1',
        escalation: OPEN_ESCALATION,
        staffMessage: STAFF_MESSAGE,
        staffContextText: STAFF_MESSAGE.inbound_text,
        decision: 'custom_instruction',
        instructionText: 'Yes, go ahead.',
      }),
    );
    expect(taskConfirmMocks.callRpcSingle).toHaveBeenCalledWith(
      'https://x.supabase.co', 'service-key', 'complete_owner_whatsapp_reply',
      { p_id: 'receipt-1', p_user_id: 'user-1', p_claim_token: 'claim-token-1', p_outcome: 'resolved_escalation', p_escalation_id: 'escalation-1' },
    );
    expect(smsMocks.sendMetaMessage).toHaveBeenCalledTimes(1);
    expect(smsMocks.sendMetaMessage.mock.calls[0][0].payload.text.body).toContain('Christopher');
  });

  it('no quoted reply, exactly one open escalation — that escalation is resolved without asking which one', async () => {
    stubEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([OPEN_ESCALATION])) // open list
      .mockResolvedValueOnce(jsonResponse([STAFF_MESSAGE]));
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: true, claim_token: 'claim-token-1', status: 'claimed', outcome: null }],
    });
    taskConfirmMocks.resolveAndDeliverEscalationAnswer.mockResolvedValueOnce({ kind: 'success', status: 'in_progress', ownerReplyText: 'x' });
    taskConfirmMocks.callRpcSingle.mockResolvedValueOnce({ data: { id: 'receipt-1', status: 'completed' } });

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key', msg: baseMsg(),
    });

    expect(result).toEqual({ isOwner: true, handled: true, reason: 'resolved_escalation' });
    expect(taskConfirmMocks.resolveAndDeliverEscalationAnswer).toHaveBeenCalledTimes(1);
  });

  it('zero open escalations — a truthful zero-match reply is sent, never "not supported", never a guess', async () => {
    stubEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([])); // open list: empty
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: true, claim_token: 'claim-token-1', status: 'claimed', outcome: null }],
    });
    taskConfirmMocks.callRpcSingle.mockResolvedValueOnce({ data: { id: 'receipt-1', status: 'completed' } });

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key', msg: baseMsg(),
    });

    expect(result).toEqual({ isOwner: true, handled: true, reason: 'zero_match' });
    expect(taskConfirmMocks.resolveAndDeliverEscalationAnswer).not.toHaveBeenCalled();
    expect(taskConfirmMocks.callRpcSingle).toHaveBeenCalledWith(
      'https://x.supabase.co', 'service-key', 'complete_owner_whatsapp_reply',
      expect.objectContaining({ p_outcome: 'zero_match', p_escalation_id: null }),
    );
    const sentText = smsMocks.sendMetaMessage.mock.calls[0][0].payload.text.body;
    expect(sentText.toLowerCase()).not.toContain('not supported');
    expect(sentText).not.toMatch(/success|done|sent to/i);
  });

  it('two or more open escalations, no quoted reply — asks which one, never defaults to the most recent', async () => {
    stubEnv();
    const secondEscalation = { ...OPEN_ESCALATION, id: 'escalation-2', staff_message_id: 'staff-message-2', deep_link_token: 'token-2' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([OPEN_ESCALATION, secondEscalation]));
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: true, claim_token: 'claim-token-1', status: 'claimed', outcome: null }],
    });
    taskConfirmMocks.callRpcSingle.mockResolvedValueOnce({ data: { id: 'receipt-1', status: 'completed' } });

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key', msg: baseMsg(),
    });

    expect(result).toEqual({ isOwner: true, handled: true, reason: 'clarification_sent' });
    expect(taskConfirmMocks.resolveAndDeliverEscalationAnswer).not.toHaveBeenCalled();
    expect(taskConfirmMocks.callRpcSingle).toHaveBeenCalledWith(
      'https://x.supabase.co', 'service-key', 'complete_owner_whatsapp_reply',
      expect.objectContaining({ p_outcome: 'clarification_sent', p_escalation_id: null }),
    );
  });

  it('a matched escalation whose linked staff_messages row cannot be resolved never guesses — sends a recovery reply instead', async () => {
    stubEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([OPEN_ESCALATION]))
      .mockResolvedValueOnce(jsonResponse([{ ...STAFF_MESSAGE, inbound_text: '' }])); // blank context text
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: true, claim_token: 'claim-token-1', status: 'claimed', outcome: null }],
    });
    taskConfirmMocks.callRpcSingle.mockResolvedValueOnce({ data: { id: 'receipt-1', status: 'completed' } });

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key', msg: baseMsg(),
    });

    expect(result).toEqual({ isOwner: true, handled: true, reason: 'clarification_sent' });
    expect(taskConfirmMocks.resolveAndDeliverEscalationAnswer).not.toHaveBeenCalled();
    expect(taskConfirmMocks.callRpcSingle).toHaveBeenCalledWith(
      'https://x.supabase.co', 'service-key', 'complete_owner_whatsapp_reply',
      expect.objectContaining({ p_outcome: 'clarification_sent', p_escalation_id: 'escalation-1' }),
    );
  });

  it('a shared-helper delivery failure is reported truthfully — never as success, never a duplicate attempt', async () => {
    stubEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([OPEN_ESCALATION]))
      .mockResolvedValueOnce(jsonResponse([STAFF_MESSAGE]));
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: true, claim_token: 'claim-token-1', status: 'claimed', outcome: null }],
    });
    taskConfirmMocks.resolveAndDeliverEscalationAnswer.mockResolvedValueOnce({ kind: 'send_error' });
    taskConfirmMocks.callRpcSingle.mockResolvedValueOnce({ data: { id: 'receipt-1', status: 'completed' } });

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key', msg: baseMsg(),
    });

    expect(result).toEqual({ isOwner: true, handled: true, reason: 'clarification_sent' });
    expect(taskConfirmMocks.resolveAndDeliverEscalationAnswer).toHaveBeenCalledTimes(1);
    const sentText = smsMocks.sendMetaMessage.mock.calls[0][0].payload.text.body;
    expect(sentText).not.toMatch(/success|done|sent to/i);
  });
});

describe('handleInboundOwnerReply — failure ordering and safety', () => {
  it('never writes a staff_messages row for the owner\'s own reply', async () => {
    stubEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([OPEN_ESCALATION]))
      .mockResolvedValueOnce(jsonResponse([STAFF_MESSAGE]));
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: true, claim_token: 'claim-token-1', status: 'claimed', outcome: null }],
    });
    taskConfirmMocks.resolveAndDeliverEscalationAnswer.mockResolvedValueOnce({ kind: 'success', status: 'delivered', ownerReplyText: 'x' });
    taskConfirmMocks.callRpcSingle.mockResolvedValueOnce({ data: { id: 'receipt-1', status: 'completed' } });

    await handleInboundOwnerReply({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key', msg: baseMsg() });

    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      const method = call[1]?.method || 'GET';
      expect(!(url.includes('/staff_messages') && method !== 'GET')).toBe(true);
    }
  });

  it('a completion RPC failure marks the receipt failed (retryable) and never sends a reply for that attempt', async () => {
    stubEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([])); // zero open escalations
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: true, claim_token: 'claim-token-1', status: 'claimed', outcome: null }],
    });
    taskConfirmMocks.callRpcSingle
      .mockResolvedValueOnce({ error: { status: 409, message: 'stale_receipt_claim' } }) // complete fails
      .mockResolvedValueOnce({ data: { id: 'receipt-1', status: 'failed' } }); // fail_owner_whatsapp_reply succeeds

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key', msg: baseMsg(),
    });

    expect(result).toEqual({ isOwner: true, handled: false, reason: 'complete_failed' });
    expect(smsMocks.sendMetaMessage).not.toHaveBeenCalled();
    expect(taskConfirmMocks.callRpcSingle).toHaveBeenNthCalledWith(2,
      'https://x.supabase.co', 'service-key', 'fail_owner_whatsapp_reply',
      { p_id: 'receipt-1', p_user_id: 'user-1', p_claim_token: 'claim-token-1', p_error: 'stale_receipt_claim' },
    );
  });

  it('a correlation-phase exception marks the receipt failed (retryable) rather than leaving it claimed forever', async () => {
    stubEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce({ ok: false, status: 500, json: vi.fn().mockResolvedValue({}) }); // open-escalations lookup fails
    vi.stubGlobal('fetch', fetchMock);
    taskConfirmMocks.callRpcRows.mockResolvedValueOnce({
      data: [{ receipt_id: 'receipt-1', claimed: true, claim_token: 'claim-token-1', status: 'claimed', outcome: null }],
    });
    taskConfirmMocks.callRpcSingle.mockResolvedValueOnce({ data: { id: 'receipt-1', status: 'failed' } });

    const result = await handleInboundOwnerReply({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key', msg: baseMsg(),
    });

    expect(result).toEqual({ isOwner: true, handled: false, reason: 'processing_failed' });
    expect(taskConfirmMocks.callRpcSingle).toHaveBeenCalledWith(
      'https://x.supabase.co', 'service-key', 'fail_owner_whatsapp_reply',
      expect.objectContaining({ p_id: 'receipt-1', p_user_id: 'user-1', p_claim_token: 'claim-token-1' }),
    );
    expect(smsMocks.sendMetaMessage).not.toHaveBeenCalled();
  });
});
