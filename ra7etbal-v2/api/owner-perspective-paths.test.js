import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendWhatsappTask = vi.hoisted(() => vi.fn());
vi.mock('./send-whatsapp-task.js', async (importOriginal) => ({ ...(await importOriginal()), default: sendWhatsappTask }));

import { persistAndExecuteOwnerCommand } from './_owner-command-executor.js';
import { buildFollowUpMessageText } from './process-delegation-escalations.js';
import { buildNoResponseReaskMessage } from './_no-response-handoff.js';
import { ownerPerspectiveClarification } from '../shared/owner-perspective.js';

/**
 * Protected: every server-side recipient-facing path resolves owner
 * perspective through the single contract (shared/owner-perspective.js) —
 * WhatsApp owner commands (direct and tracked), follow-ups and no-response
 * re-asks — and fails closed rather than guessing.
 */

const SUPABASE = 'https://example.supabase.co';
const receipt = { receipt_id: '00000000-0000-4000-8000-000000000001', claim_token: 'claim-1' };
const identity = { userId: 'user-1', ownerPhone: '971500000001' };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(data) });
const recorded = (overrides = {}) => ({
  id: receipt.receipt_id, retry_count: 1, max_retries: 5, acknowledgement_status: 'pending', execution_result: {},
  action_task_id: null, action_message_id: null, staff_transport_message_id: null, ...overrides,
});

function stubFetch(person) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const target = String(url);
    if (target.includes('/rpc/record_owner_whatsapp_command')) return response(recorded());
    if (target.includes('/profiles?')) return response([{ display_name: 'Sana' }]);
    if (target.includes('/people?')) return response([person]);
    if (target.endsWith('/rest/v1/tasks') && options.method === 'POST') return response([{ ...JSON.parse(options.body), created_at: '2026-10-02T08:00:00.000Z' }]);
    if (target.endsWith('/rest/v1/messages') && options.method === 'POST') return response([JSON.parse(options.body)]);
    if (target.includes('/owner_whatsapp_reply_receipts?') && options.method === 'PATCH') return response([recorded()]);
    if (target.includes('/whatsapp_deliveries?')) return response([]);
    if (target.startsWith('https://qstash.upstash.io/')) return response({ messageId: 'qstash-1' });
    throw new Error(`unexpected fetch ${target}`);
  }));
  return calls;
}
const run = (body) => persistAndExecuteOwnerCommand({ supabaseUrl: SUPABASE, serviceKey: 'service-key', identity, receipt, msg: { body, phoneNumberId: 'phone-1' } });
const posted = (calls, table) => calls.filter((c) => c.url.endsWith(`/rest/v1/${table}`) && c.options.method === 'POST').map((c) => JSON.parse(c.options.body));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env.QSTASH_TOKEN = 'qstash-token';
  process.env.CRON_SECRET = 'cron-secret';
  process.env.APP_BASE_URL = 'https://www.ra7etbal.com';
  sendWhatsappTask.mockReset();
  sendWhatsappTask.mockImplementation(async (_req, res) => res.status(200).json({ success: true, messageId: 'wamid.staff-1' }));
});

describe('WhatsApp owner command — owner perspective', () => {
  it('direct message: "Tell Loulya I would like her to call me" reaches Loulya in consistent recipient perspective', async () => {
    const calls = stubFetch({ id: 'p-l', name: 'Loulya', phone: '+971500000009', whatsapp_opted_in: true, is_family: true });
    const result = await run('Tell Loulya I would like her to call me');
    expect(result.kind).toBe('completed');
    expect(posted(calls, 'tasks')).toEqual([]);
    expect(sendWhatsappTask.mock.calls[0][0].body.messageText).toBe('Sana would like you to call Sana');
    expect(posted(calls, 'messages')[0].content).toBe('Sana would like you to call Sana');
  });

  it('tracked delegation: the stored task description and the staff message both name the owner (no raw "my")', async () => {
    const calls = stubFetch({ id: 'p-g', name: 'Grace', phone: '+971500000002', whatsapp_opted_in: true, is_family: false });
    const result = await run('Ask Grace to put it in my room');
    expect(result.kind).toBe('completed');
    expect(posted(calls, 'tasks')[0].description).toBe("put it in Sana's room");
    expect(sendWhatsappTask.mock.calls[0][0].body.messageText).toBe("put it in Sana's room");
  });

  it('fails closed: an unresolvable owner reflexive sends nothing, creates no task or message, and asks the owner to rephrase (terminal, no retry)', async () => {
    const calls = stubFetch({ id: 'p-g', name: 'Grace', phone: '+971500000002', whatsapp_opted_in: true, is_family: false });
    const result = await run('Tell Grace I did it myself');
    expect(result.kind).toBe('terminal_failed');
    expect(result.acknowledgement).toBe(ownerPerspectiveClarification('Grace'));
    expect(posted(calls, 'tasks')).toEqual([]);
    expect(posted(calls, 'messages')).toEqual([]);
    expect(sendWhatsappTask).not.toHaveBeenCalled();
    const update = calls.find((c) => c.url.includes('/owner_whatsapp_reply_receipts?') && JSON.parse(c.options.body).execution_status);
    expect(JSON.parse(update.options.body)).toMatchObject({ execution_status: 'terminal_failed', next_retry_at: null, execution_error: 'owner_perspective_unresolved:owner_reflexive' });
  });
});

describe('WhatsApp owner command — no model call; unverifiable non-English bodies fail closed', () => {
  it.each([
    ['Text Loulya الغدا جاهز', 'unverifiable_language'],
    ['Text Loulya akşam yemeği hazır', 'unverifiable_language'],
    ['Text Loulya بروح السوق', 'arabic_owner_first_person'],
    ['Ask Grace to bring the bags, eve geliyorum', 'turkish_owner_first_person'],
  ])('"%s" sends nothing and ends terminal (%s), with zero model calls', async (body, reason) => {
    const isGrace = body.includes('Grace');
    const calls = stubFetch(isGrace
      ? { id: 'p-g', name: 'Grace', phone: '+971500000002', whatsapp_opted_in: true, is_family: false }
      : { id: 'p-l', name: 'Loulya', phone: '+971500000009', whatsapp_opted_in: true, is_family: true });
    const result = await run(body);
    expect(result.kind).toBe('terminal_failed');
    expect(result.acknowledgement).toBe(ownerPerspectiveClarification(isGrace ? 'Grace' : 'Loulya'));
    expect(posted(calls, 'tasks')).toEqual([]);
    expect(posted(calls, 'messages')).toEqual([]);
    expect(sendWhatsappTask).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes('anthropic'))).toBe(false);
    const update = calls.find((c) => c.url.includes('/owner_whatsapp_reply_receipts?') && JSON.parse(c.options.body).execution_status);
    expect(JSON.parse(update.options.body)).toMatchObject({ execution_status: 'terminal_failed', execution_error: `owner_perspective_unresolved:${reason}` });
  });

  it('existing English behavior is unchanged', async () => {
    const calls = stubFetch({ id: 'p-l', name: 'Loulya', phone: '+971500000009', whatsapp_opted_in: true, is_family: true });
    const result = await run('Text Loulya dinner is at 8');
    expect(result.kind).toBe('completed');
    expect(posted(calls, 'messages')[0].content).toBe('dinner is at 8');
  });
});

describe('Follow-up and no-response re-ask — owner perspective of the stored task record', () => {
  it.each([
    ['put it in my room', "Following up: put it in Sana's room"],
    ['meet me outside', 'Following up: meet Sana outside'],
    ["put it in Sana's room", "Following up: put it in Sana's room"],
    ['Take Loulya to her appointment and call me after.', 'Following up: Take Loulya to her appointment and call Sana after.'],
  ])('follow-up for "%s"', (description, expected) => {
    expect(buildFollowUpMessageText({ description, ownerName: 'Sana', assignedTo: 'Grace' })).toBe(expected);
  });

  it('follow-up never renders broken grammar or rewrites a third party / quote (retired blanket rewriter)', () => {
    // The retired rewriter produced "Sana'm", "Sana did it Sana", "Grace said Sana would call back".
    expect(buildFollowUpMessageText({ description: "I'm running late", ownerName: 'Sana', assignedTo: 'Grace' })).toBe('Following up: Sana is running late');
    expect(buildFollowUpMessageText({ description: 'She texted "I am on my way"', ownerName: 'Sana', assignedTo: 'Grace' })).toBe('Following up: She texted "I am on my way"');
  });

  it('follow-up fails closed to a neutral line that does not quote an unresolvable task', () => {
    // Includes the retired rule's own example: "you" in a stored record is ambiguous.
    for (const description of ['I did it myself', 'Grace said I would call back', 'اتصلي فيني', 'Call me and tell her the plan', 'text you in one minute',
      'بروح السوق', 'الغدا جاهز', 'Eve geliyorum', 'Akşam yemeği hazır',
      // the assignee named as a third party in their own follow-up (stored by the retired path)
      'Tell Grace Sana is running late']) {
      expect(buildFollowUpMessageText({ description, ownerName: 'Sana', assignedTo: 'Grace' }), description).toBe('Following up on the task Sana sent you.');
    }
  });

  it('no-response re-ask renders the task through the same contract, and fails closed the same way', () => {
    const url = 'https://www.ra7etbal.com/confirm?task=t1';
    expect(buildNoResponseReaskMessage({ assignedTo: 'Grace', taskDescription: 'put it in my room.', ownerName: 'Sana', confirmationUrl: url }))
      .toBe(`Hi Grace, checking in again about: put it in Sana's room. Please confirm here when it's done: ${url}`);
    expect(buildNoResponseReaskMessage({ assignedTo: 'Grace', taskDescription: "I'm running late", ownerName: 'Sana', confirmationUrl: url }))
      .toBe(`Hi Grace, checking in again about: Sana is running late. Please confirm here when it's done: ${url}`);
    expect(buildNoResponseReaskMessage({ assignedTo: 'Grace', taskDescription: 'I did it myself', ownerName: 'Sana', confirmationUrl: url }))
      .toBe(`Hi Grace, checking in again about the task Sana sent you. Please confirm here when it's done: ${url}`);
  });
});
