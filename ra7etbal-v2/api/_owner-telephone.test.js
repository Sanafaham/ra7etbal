import { describe, it, expect, vi, afterEach } from 'vitest';
import { runOwnerTelephoneSweep, handleOwnerTelephone, telephoneConfig, agentFingerprint, toolFingerprint, PHONE_PROMPT, PHONE_FIRST_MESSAGE } from './_owner-telephone.js';
import { getOrCreateOwnerNotification } from './_owner-notifications.js';
import taskConfirmHandler from './task-confirm.js';

const U = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const N = '55555555-5555-4555-8555-555555555555';
const LINK = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-10-19T12:00:00Z');
const phoneTool = { type: 'webhook', name: 'owner_phone', pre_tool_speech: 'off', api_schema: { method: 'POST', url: 'https://www.ra7etbal.com/api/task-confirm?ownerTelephone=tool', request_body_schema: { properties: { receiptId: { dynamic_variable: 'owner_phone_receipt_id' } } } } };
const agent = { agent_id: 'phone-agent', conversation_config: {
  conversation: { max_duration_seconds: 180 }, agent: { first_message: PHONE_FIRST_MESSAGE, prompt: { prompt: PHONE_PROMPT, tool_ids: ['tool-phone'], built_in_tools: { end_call: { type: 'system', name: 'end_call' } } } },
}, platform_settings: { privacy: { record_voice: false, retention_days: 7, delete_audio: true, delete_transcript_and_pii: true } } };
const policy = { callbackOrigin: 'https://www.ra7etbal.com', reviewedAgentSha256: agentFingerprint(agent), reviewedToolSha256: toolFingerprint(phoneTool), consentVersion: 'phone-v1',
  cutoverAt: '2026-10-19T00:00:00Z', reviewExpiresAt: '2026-10-25T00:00:00Z', dailyLimit: 2, monthlyLimit: 20,
  maxCallSeconds: 180, retentionDays: 7, timeZone: 'UTC', startHour: 9, endHour: 20,
  allowedPrefixes: ['+1'], maxPerMinuteUsd: 0.3, monthlyBudgetUsd: 20, privacyAndInternationalReviewed: true };
const env = { OWNER_TELEPHONE_ENABLED: 'true', OWNER_TELEPHONE_RETENTION_ENABLED: 'true', OWNER_TELEPHONE_USER_ID: U, ELEVENLABS_API_KEY: 'test-api-key',
  ELEVENLABS_PHONE_AGENT_ID: 'phone-agent', ELEVENLABS_PHONE_NUMBER_ID: 'twilio-number',
  OWNER_TELEPHONE_SECRET: 'x'.repeat(32), OWNER_TELEPHONE_PROVIDER_SECRET: 'y'.repeat(32), OWNER_TELEPHONE_POLICY: JSON.stringify(policy) };
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });

// In-memory PostgREST double executes unique insert + conditional UPDATE
// semantics, not just a sequence of canned HTTP successes.
function fixture() {
  const db = { owner_notifications: [], staff_escalation_owner_decisions: [{ id: D, user_id: U, task_id: T, staff_message_id: S, status: 'open', created_at: NOW.toISOString(), deep_link_token: LINK }],
    tasks: [{ id: T, user_id: U, description: 'Buy salmon for dinner', status: 'pending', confirmed_at: null, archived_at: null, dismissed_at: null }],
    staff_messages: [{ id: S, user_id: U, task_id: T, staff_name: 'Test worker', inbound_text: 'Salmon is unavailable. Can I get trout?', source: 'whatsapp', classification: 'substitution_request', processing_status: 'completed', owner_attention_required: true, next_action_owner: 'owner', escalation_reason: 'An alternative needs your approval.' }],
    people: [{ name: 'Boss', role: 'boss', phone: '+12025550123', user_id: U }], account_deletion_requests: [] };
  let serial = 0;
  let providerResult = { success: true, conversation_id: 'conv-test', callSid: 'CA-test' };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    if (url.includes('/agents/')) return reply(agent);
    if (url.includes('/tools/')) return reply({ tool_config: phoneTool });
    if (url.endsWith('/twilio/outbound-call')) {
      if (providerResult instanceof Error) throw providerResult;
      return reply(providerResult);
    }
    const parsed = new URL(url), table = parsed.pathname.split('/').pop();
    if (!(table in db)) throw new Error(`Unexpected network ${table}`);
    const data = db[table];
    const body = init.body ? JSON.parse(init.body) : null;
    const matches = row => [...parsed.searchParams].every(([k, v]) => {
      if (['select', 'order', 'limit'].includes(k)) return true;
      const val = k.startsWith('metadata->>') ? row.metadata?.[k.slice(11)] : row[k];
      if (v.startsWith('eq.')) return String(val) === v.slice(3);
      if (v.startsWith('gte.')) return val >= v.slice(4);
      if (v.startsWith('lte.')) return val <= v.slice(4);
      if (v.startsWith('neq.')) return String(val) !== v.slice(4);
      if (v.startsWith('not.in.(')) return !v.slice(8, -1).split(',').includes(String(val));
      if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(val));
      throw new Error(`Unexpected filter ${k}=${v}`);
    });
    if (init.method === 'POST') {
      if (data.some(r => r.user_id === body.user_id && r.event_key === body.event_key)) return reply({ code: '23505', message: 'owner_notifications_user_event_key_key' }, 409);
      const row = { id: serial++ === 0 ? N : `77777777-7777-4777-8777-${String(serial).padStart(12, '0')}`, ...body };
      data.push(row);
      return reply([row]);
    }
    const selected = data.filter(matches);
    if (init.method === 'PATCH') selected.forEach(row => Object.assign(row, body));
    return reply(selected);
  });
  const ctx = { supabaseUrl: 'https://database.test', serviceKey: 'test-service', env, now: NOW, fetchImpl,
    notificationImpl: args => getOrCreateOwnerNotification(args) };
  vi.stubGlobal('fetch', fetchImpl);
  return { db, ctx, fetchImpl, provider: x => { providerResult = x; },
    dialCount: () => fetchImpl.mock.calls.filter(([u]) => u.endsWith('/twilio/outbound-call')).length,
    receipt: () => db.owner_notifications.find(r => r.kind === 'owner_telephone'),
    dialBody: () => JSON.parse(fetchImpl.mock.calls.find(([u]) => u.endsWith('/twilio/outbound-call'))[1].body) };
}
function response() {
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
}
async function owner(f, body, uid = U) {
  const res = response();
  await handleOwnerTelephone({ method: 'POST', query: { ownerTelephone: 'owner' }, body }, res, { ...f.ctx, authenticateOwner: async () => ({ uid }) });
  return res;
}
async function tool(f, body, headers = {}) {
  const res = response();
  await handleOwnerTelephone({ method: 'POST', query: { ownerTelephone: 'tool' },
    headers: { authorization: `Bearer ${env.OWNER_TELEPHONE_PROVIDER_SECRET}`, 'x-carson-phone-token': f.dialBody().conversation_initiation_client_data.dynamic_variables.secret__owner_phone_token, ...headers },
    body: { receiptId: f.receipt().id, ...body } }, res, f.ctx);
  return res;
}
async function authenticate(f) {
  const result = await owner(f, { receiptId: f.receipt().id, consent: true });
  return tool(f, { action: 'authenticate', code: result.body.code });
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('Stage 1 telephone defaults and eligibility', () => {
  it('is completely inert by default, including provider and database calls', async () => {
    const f = fixture();
    expect(await runOwnerTelephoneSweep({ ...f.ctx, env: {} })).toEqual({ status: 'disabled' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    ['flag', { ...env, OWNER_TELEPHONE_ENABLED: 'false' }],
    ['secret', { ...env, OWNER_TELEPHONE_SECRET: 'short' }],
    ['separate secrets', { ...env, OWNER_TELEPHONE_SECRET: env.OWNER_TELEPHONE_PROVIDER_SECRET }],
    ['policy', { ...env, OWNER_TELEPHONE_POLICY: '{}' }],
    ['daily limit', { ...env, OWNER_TELEPHONE_POLICY: JSON.stringify({ ...policy, dailyLimit: 999 }) }],
    ['rate', { ...env, OWNER_TELEPHONE_POLICY: JSON.stringify({ ...policy, maxPerMinuteUsd: 0 }) }],
    ['international', { ...env, OWNER_TELEPHONE_POLICY: JSON.stringify({ ...policy, privacyAndInternationalReviewed: false }) }],
  ])('fails closed for missing or unsafe %s', (_, config) => expect(telephoneConfig(config)).toBeNull());
  it('honors quiet hours and expiring activation review', async () => {
    const f = fixture();
    expect((await runOwnerTelephoneSweep({ ...f.ctx, now: new Date('2026-10-19T23:00:00Z') })).status).toBe('quiet_hours');
    expect((await runOwnerTelephoneSweep({ ...f.ctx, now: new Date('2026-11-01') })).status).toBe('disabled');
    expect(f.dialCount()).toBe(0);
  });
  it.each([
    ['completed task', f => { f.db.tasks[0].status = 'completed'; }],
    ['archived task', f => { f.db.tasks[0].archived_at = NOW.toISOString(); }],
    ['confirmed task', f => { f.db.tasks[0].confirmed_at = NOW.toISOString(); }],
    ['routine update', f => { f.db.staff_messages[0].classification = 'task_update'; }],
    ['unlinked message', f => { f.db.staff_messages[0].task_id = null; }],
    ['ambiguous task', f => { f.db.staff_escalation_owner_decisions[0].task_id = null; }],
    ['owner not needed', f => { f.db.staff_messages[0].owner_attention_required = false; }],
    ['resolved decision', f => { f.db.staff_escalation_owner_decisions[0].status = 'answered'; }],
    ['old backlog', f => { f.db.staff_escalation_owner_decisions[0].created_at = '2026-10-18T00:00:00Z'; }],
    ['simulated message', f => { f.db.staff_messages[0].source = 'simulated'; }],
  ])('does not call for %s', async (_, mutate) => {
    const f = fixture(); mutate(f);
    await runOwnerTelephoneSweep(f.ctx);
    expect(f.dialCount()).toBe(0);
  });
  it('does not disclose private context in the outbound initialization', async () => {
    const f = fixture();
    expect((await runOwnerTelephoneSweep(f.ctx)).status).toBe('dispatched');
    const body = f.dialBody();
    expect(body.to_number).toBe('+12025550123');
    expect(body.call_recording_enabled).toBe(false);
    expect(body.telephony_call_config).toEqual({ ringing_timeout_secs: 30, twilio_call_recording_enabled: false });
    expect(JSON.stringify(body)).not.toMatch(/salmon|trout|test-service|test-api-key/i);
    expect(f.receipt().metadata.conversationId).toBe('conv-test');
  });
  it('atomically prevents duplicate calls from simultaneous sweeps and subsequent runs', async () => {
    const f = fixture();
    await Promise.all([runOwnerTelephoneSweep(f.ctx), runOwnerTelephoneSweep(f.ctx)]);
    await runOwnerTelephoneSweep(f.ctx);
    expect(f.dialCount()).toBe(1);
    expect(f.db.owner_notifications.filter(r => r.kind === 'owner_telephone')).toHaveLength(1);
  });
  it('never redials after ambiguous provider timeout', async () => {
    const f = fixture(); f.provider(new Error('timeout'));
    expect((await runOwnerTelephoneSweep(f.ctx)).status).toBe('not_confirmed');
    await runOwnerTelephoneSweep(f.ctx);
    expect(f.dialCount()).toBe(1);
    expect(f.receipt().metadata.state).toBe('dispatch_unconfirmed');
  });
  it('blocks frozen accounts before all provider requests', async () => {
    const f = fixture(); f.db.account_deletion_requests.push({ user_id: U, status: 'in_progress' });
    await expect(runOwnerTelephoneSweep(f.ctx)).rejects.toThrow('telephone_account_unavailable');
    expect(f.fetchImpl.mock.calls.some(([u]) => u.includes('api.elevenlabs.io'))).toBe(false);
  });
  it('blocks unreviewed international numbers, ambiguous owner and agent drift', async () => {
    const f = fixture(); f.db.people[0].phone = '+442012345678';
    await expect(runOwnerTelephoneSweep(f.ctx)).rejects.toThrow('telephone_destination_not_reviewed');
    f.db.people.push({ ...f.db.people[0] });
    await expect(runOwnerTelephoneSweep(f.ctx)).rejects.toThrow('telephone_owner_not_unique');
    f.db.people.pop(); f.db.people[0].phone = '+12025550123';
    await expect(runOwnerTelephoneSweep({ ...f.ctx, env: { ...env, OWNER_TELEPHONE_POLICY: JSON.stringify({ ...policy, reviewedAgentSha256: '0'.repeat(64) }) } })).rejects.toThrow('telephone_agent_not_reviewed');
    expect(f.dialCount()).toBe(0);
  });
});

describe('Authenticated phone answer journey', () => {
  it('binds the correct task, reads back a proposal and records only the confirmed version without execution', async () => {
    const f = fixture(); await runOwnerTelephoneSweep(f.ctx);
    const result = await authenticate(f);
    expect(result.body.authenticated).toBe(true);
    expect(result.body.task).toBe('Buy salmon for dinner');
    const p = await tool(f, { action: 'propose', answer: 'Get trout instead, within the same budget.' });
    expect(p.body.readBack).toContain('Get trout instead');
    const recorded = await tool(f, { action: 'confirm', proposalId: p.body.proposalId, confirmed: true });
    expect(recorded.body).toMatchObject({ recorded: true, executed: false });
    expect(f.receipt().target_id).toBe(T);
    expect(f.receipt().metadata.confirmedAnswer).toBe('Get trout instead, within the same budget.');
    expect(f.db.staff_escalation_owner_decisions[0].status).toBe('open');
    expect(f.db.tasks[0].status).toBe('pending');
    expect(f.fetchImpl.mock.calls.filter(([u, init]) => init?.method === 'PATCH').every(([u]) => u.includes('/owner_notifications?'))).toBe(true);
    const review = await owner(f, { receiptId: f.receipt().id });
    expect(review.body.decisionUrl).toBe(`/confirm?token=${LINK}`);
    expect(review.body.answer).toContain('Get trout');
    expect(review.headers['Cache-Control']).toBe('no-store');
  });
  it('denies cross-owner app requests and missing provider/call authentication', async () => {
    const f = fixture(); await runOwnerTelephoneSweep(f.ctx);
    expect((await owner(f, { receiptId: f.receipt().id, consent: true }, D)).statusCode).toBe(401);
    expect((await tool(f, { action: 'authenticate' }, { authorization: '' })).statusCode).toBe(401);
    expect((await tool(f, { action: 'authenticate' }, { 'x-carson-phone-token': 'forged' })).statusCode).toBe(401);
    expect(f.receipt().metadata.authAttempts).toBe(0);
  });
  it('requires explicit in-app consent and locks out after three wrong codes', async () => {
    const f = fixture(); await runOwnerTelephoneSweep(f.ctx);
    expect((await tool(f, { action: 'authenticate', code: '000000' })).statusCode).toBe(409);
    const { body: { code } } = await owner(f, { receiptId: f.receipt().id, consent: true });
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) expect((await tool(f, { action: 'authenticate', code: wrong })).statusCode).toBe(403);
    expect((await tool(f, { action: 'authenticate', code })).statusCode).toBe(409);
    expect(f.receipt().metadata.state).toBe('verification_failed');
  });
  it('does not accept answers before auth, confirmation without proposal, stale proposal or ambiguity', async () => {
    const f = fixture(); await runOwnerTelephoneSweep(f.ctx);
    expect((await tool(f, { action: 'propose', answer: 'Go ahead' })).statusCode).toBe(409);
    await authenticate(f);
    expect((await tool(f, { action: 'confirm', confirmed: true })).statusCode).toBe(409);
    const a = await tool(f, { action: 'propose', answer: 'Get trout' });
    const b = await tool(f, { action: 'propose', answer: 'Do not buy anything' });
    expect((await tool(f, { action: 'confirm', proposalId: a.body.proposalId, confirmed: true })).statusCode).toBe(409);
    expect((await tool(f, { action: 'confirm', proposalId: b.body.proposalId, confirmed: false })).statusCode).toBe(409);
    expect(f.receipt().metadata.confirmedAnswer).toBeUndefined();
  });
  it('does not overwrite a recorded response on replay', async () => {
    const f = fixture(); await runOwnerTelephoneSweep(f.ctx); await authenticate(f);
    const p = await tool(f, { action: 'propose', answer: 'Wait for me' });
    await tool(f, { action: 'confirm', proposalId: p.body.proposalId, confirmed: true });
    expect((await tool(f, { action: 'propose', answer: 'Buy now' })).statusCode).toBe(409);
    expect(f.receipt().metadata.confirmedAnswer).toBe('Wait for me');
  });
  it('fails closed if resolved or frozen during the phone conversation', async () => {
    const f = fixture(); await runOwnerTelephoneSweep(f.ctx); await authenticate(f);
    f.db.staff_escalation_owner_decisions[0].status = 'answered';
    expect((await tool(f, { action: 'propose', answer: 'Go ahead' })).statusCode).toBe(409);
    f.db.staff_escalation_owner_decisions[0].status = 'open';
    f.db.account_deletion_requests.push({ user_id: U, status: 'failed_retryable' });
    expect((await tool(f, { action: 'propose', answer: 'Go ahead' })).statusCode).toBe(409);
  });
  it('expires unattended/voicemail calls without resolving or retrying the decision', async () => {
    const f = fixture(); await runOwnerTelephoneSweep(f.ctx);
    f.ctx.now = new Date('2026-10-19T12:10:00Z');
    expect((await tool(f, { action: 'authenticate', code: '123456' })).statusCode).toBe(409);
    await runOwnerTelephoneSweep(f.ctx);
    expect(f.receipt().metadata.state).toBe('ended_without_confirmed_answer');
    expect(f.dialCount()).toBe(1);
    expect(f.db.staff_escalation_owner_decisions[0].status).toBe('open');
  });
});

describe('Telephone spending, concurrency and privacy regressions', () => {
  function extraDecision(f, id) {
    f.db.staff_escalation_owner_decisions.push({ ...f.db.staff_escalation_owner_decisions[0], id });
  }
  it('serializes different decisions for the same owner and defers rather than loses the second', async () => {
    const f = fixture(); await runOwnerTelephoneSweep(f.ctx);
    extraDecision(f, '88888888-8888-4888-8888-888888888888');
    await runOwnerTelephoneSweep(f.ctx);
    expect(f.dialCount()).toBe(1);
    expect(f.db.owner_notifications.find(r => r.metadata?.decisionId?.startsWith('8888')).metadata.state).toBe('queued');
    f.ctx.now = new Date('2026-10-19T12:05:00Z');
    await runOwnerTelephoneSweep(f.ctx);
    expect(f.dialCount()).toBe(2);
    const budget = f.db.owner_notifications.find(r => r.kind === 'owner_telephone_budget');
    expect(budget.metadata.monthCount).toBe(2);
    expect(budget.read_at).toBeTruthy();
    expect(budget.dismissed_at).toBeTruthy();
    extraDecision(f, '99999999-9999-4999-8999-999999999999');
    f.ctx.now = new Date('2026-10-19T12:10:00Z');
    await runOwnerTelephoneSweep(f.ctx);
    expect(f.dialCount()).toBe(2); // daily cap includes failed and unanswered attempts
  });
  it('bounds concurrent DIFFERENT decisions through a single shared conditional budget write', async () => {
    const f = fixture();
    extraDecision(f, '88888888-8888-4888-8888-888888888888');
    await Promise.allSettled([runOwnerTelephoneSweep(f.ctx), runOwnerTelephoneSweep(f.ctx), runOwnerTelephoneSweep(f.ctx)]);
    expect(f.dialCount()).toBe(1);
  });
  it.each(['monthlyLimit', 'monthlyBudgetUsd'])('fails closed when %s is exhausted', async field => {
    const f = fixture(); await runOwnerTelephoneSweep(f.ctx);
    extraDecision(f, '88888888-8888-4888-8888-888888888888');
    f.ctx.now = new Date('2026-10-20T12:00:00Z');
    const next = { ...policy, [field]: field === 'monthlyLimit' ? 1 : 0.9 };
    await runOwnerTelephoneSweep({ ...f.ctx, env: { ...env, OWNER_TELEPHONE_POLICY: JSON.stringify(next) } });
    expect(f.dialCount()).toBe(1);
  });
  it('does not let twenty already-attempted decisions hide an eligible older blocker', async () => {
    const f = fixture();
    for (let i = 0; i < 20; i++) {
      const id = `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`;
      extraDecision(f, id);
      f.db.owner_notifications.push({ id: `receipt-${i}`, user_id: U, kind: 'owner_telephone', event_key: `owner_telephone:${id}`, occurred_at: NOW.toISOString(), metadata: { state: 'recorded', decisionId: id } });
    }
    await runOwnerTelephoneSweep(f.ctx);
    expect(f.dialCount()).toBe(1);
    expect(f.receipt().metadata.decisionId).not.toBeUndefined();
  });
  it('redacts local responses on schedule even when dialing is disabled or review expired', async () => {
    const f = fixture(); await runOwnerTelephoneSweep(f.ctx); await authenticate(f);
    const p = await tool(f, { action: 'propose', answer: 'Private owner answer' });
    await tool(f, { action: 'confirm', proposalId: p.body.proposalId, confirmed: true });
    await runOwnerTelephoneSweep({ ...f.ctx, now: new Date('2026-11-01T12:00:00Z'), env: { ...env, OWNER_TELEPHONE_ENABLED: 'false' } });
    const receipt = f.receipt();
    expect(receipt.metadata.state).toBe('redacted');
    expect(JSON.stringify(receipt)).not.toContain('Private owner answer');
    expect(receipt.metadata.decisionId).toBe(D);
    expect(receipt.metadata.nonce).toBeUndefined();
    expect(f.dialCount()).toBe(1);
  });
  it.each(['missing tools', 'knowledge base'])('rejects an agent with %s even when someone fingerprints that configuration', async (unsafeCase) => {
    const f = fixture();
    const unsafe = structuredClone(agent);
    if (unsafeCase === 'missing tools') unsafe.conversation_config.agent.prompt.tool_ids = [];
    else unsafe.conversation_config.agent.prompt.knowledge_base = [{ id: 'unapproved-document' }];
    f.fetchImpl.mockImplementationOnce(() => reply([])); // retention
    // Keep normal DB double for all calls except the agent read.
    const original = f.fetchImpl.getMockImplementation();
    f.fetchImpl.mockImplementation((url, options) => url.includes('/agents/') ? reply(unsafe) : original(url, options));
    const config = { ...env, OWNER_TELEPHONE_POLICY: JSON.stringify({ ...policy, reviewedAgentSha256: agentFingerprint(unsafe) }) };
    await expect(runOwnerTelephoneSweep({ ...f.ctx, env: config })).rejects.toThrow('telephone_agent_not_reviewed');
    expect(f.dialCount()).toBe(0);
  });
});

it('recovers an expired pre-send reservation, but never retries an ambiguous dialing receipt', async () => {
  const f = fixture();
  f.db.owner_notifications.push({ id: N, user_id: U, kind: 'owner_telephone', event_key: `owner_telephone:${D}`, occurred_at: NOW.toISOString(), metadata: {
    version: 1, state: 'reserving', nonce: 'test-nonce', decisionId: D, taskId: T, authAttempts: 0,
    expiresAt: '2026-10-19T11:00:00Z', purgeAt: '2026-10-26T12:00:00Z',
  } });
  await runOwnerTelephoneSweep(f.ctx);
  expect(f.dialCount()).toBe(1);
  expect(f.receipt().metadata.state).toBe('offered');
  f.receipt().metadata.state = 'dialing';
  f.receipt().metadata.expiresAt = '2026-10-19T11:00:00Z';
  await runOwnerTelephoneSweep(f.ctx);
  expect(f.dialCount()).toBe(1);
  expect(f.receipt().metadata.state).toBe('ended_without_confirmed_answer');
});


describe('Actual task-confirm telephone dispatch boundary', () => {
  it('keeps the phone endpoint closed when configuration is unavailable', async () => {
    const f = fixture(); const res = response();
    vi.stubEnv('OWNER_TELEPHONE_ENABLED', 'false');
    await taskConfirmHandler({ method: 'POST', query: { ownerTelephone: 'tool' }, body: {}, headers: {} }, res);
    expect(res.statusCode).toBe(404);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('uses the existing owner JWT verifier and rejects unauthenticated app requests', async () => {
    const f = fixture(); const res = response();
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv('SUPABASE_URL', f.ctx.supabaseUrl);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', f.ctx.serviceKey);
    vi.stubEnv('SUPABASE_ANON_KEY', 'test-anon');
    await taskConfirmHandler({ method: 'POST', query: { ownerTelephone: 'owner' }, body: { receiptId: N, consent: true }, headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
