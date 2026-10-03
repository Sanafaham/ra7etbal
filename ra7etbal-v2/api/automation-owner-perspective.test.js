import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));

import automationsHandler from './automations.js';
import { processAutomation, processMessageAutomation, runRoutinesCore } from './process-delegation-escalations.js';

/**
 * Protected: automation and legacy-routine text a staff member will read goes
 * through the single shared owner-perspective boundary
 * (shared/owner-perspective.js, voice picked by _automation-recipient-text.js)
 *   - at creation/update (api/automations.js): the safe text is what is saved;
 *     unresolvable text → 422, nothing saved;
 *   - at send time (api/process-delegation-escalations.js): rows saved before
 *     that existed are re-resolved; unresolvable → no task, no send, the run is
 *     recorded failed and the automation paused (legacy routine: disabled).
 * Zero model calls; automation_type / routing unchanged.
 */

const SUPABASE = 'https://example.supabase.co';
const APP = 'https://ra7etbal.com';
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const people = {
  'person-grace': { id: 'person-grace', name: 'Grace', phone: '+971500000002' },
  'person-loulya': { id: 'person-loulya', name: 'Loulya', phone: '+971500000009' },
};

function router({ insertEcho = true } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, method, body });
    if (u.includes('anthropic')) throw new Error('model call attempted');
    if (u.endsWith('/auth/v1/user')) return json({ id: 'user-1' });
    if (u.includes('/rest/v1/people')) {
      const id = decodeURIComponent((u.match(/id=eq\.([^&]+)/) || [])[1] || '');
      return json(people[id] ? [people[id]] : []);
    }
    if (u.includes('/rest/v1/profiles')) return json([{ display_name: 'Sana' }]);
    if (u.includes('/rest/v1/automations') && method === 'POST') return json(insertEcho ? [{ id: 'auto-1', ...body }] : [], 201);
    if (u.includes('/rest/v1/automations') && method === 'GET') {
      return json([{ id: 'auto-1', status: 'active', instruction: 'Bring the bags.', assignee_id: 'person-grace', automation_type: 'message' }]);
    }
    if (u.includes('/rest/v1/automations') && method === 'PATCH') return json([{ id: 'auto-1', next_run_at: '2026-10-03T08:00:00.000Z', ...body }]);
    if (u.includes('/rest/v1/tasks') && method === 'POST') return json([{ id: 'task-1', ...body }], 201);
    if (u.includes('/rest/v1/automation_runs') && method === 'POST') return json([{ id: 'run-1' }], 201);
    if (u.includes('/rest/v1/')) return json([]);
    if (u.includes('/api/send-whatsapp-task')) return json({ success: true, messageId: 'wamid.1', delivery_id: 'delivery-1' });
    if (u.includes('qstash')) return json({ messageId: 'q-1' });
    return json({});
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
const sends = (calls) => calls.filter((c) => c.url.includes('/api/send-whatsapp-task'));
const writes = (calls, table, method) => calls.filter((c) => c.url.includes(`/rest/v1/${table}`) && c.method === method);
const noModel = (calls) => expect(calls.some((c) => c.url.includes('anthropic'))).toBe(false);

function req(method, body) {
  return { method, query: {}, body, headers: { authorization: 'Bearer user-jwt' } };
}
function res() {
  return { statusCode: 200, payload: null, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } };
}
const oneTime = (overrides) => ({
  title: 'Automation', cadence_type: 'once', cadence_value: {}, next_run_at: '2026-10-03T08:00:00.000Z', ...overrides,
});

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  vi.stubEnv('CRON_SECRET', 'cron-secret');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('creation — the saved text is the safe text the recipient will read', () => {
  it.each([
    ['message', 'person-grace', 'Call me when you arrive.', 'Call Sana when you arrive.'],
    ['delegation', 'person-grace', 'Bring my bag to the car.', "Bring Sana's bag to the car."],
    ['delegation', 'person-grace', 'Take Loulya to her appointment and call me after.', 'Take Loulya to her appointment and call Sana after.'],
    ['message', 'person-grace', 'Dinner is at 8.', 'Dinner is at 8.'],
  ])('%s automation %j is saved as %j (owner named, recipient "you", third party kept)', async (type, assignee, instruction, saved) => {
    const calls = router();
    const r = res();
    await automationsHandler(req('POST', oneTime({ instruction, assignee_id: assignee, automation_type: type })), r);
    expect(r.statusCode).toBe(201);
    const [insert] = writes(calls, 'automations', 'POST');
    expect(insert.body).toMatchObject({ instruction: saved, automation_type: type, assignee_id: assignee });
    noModel(calls);
  });

  it.each([
    ['Grace said I would call back.', 'person-loulya', 'reported_speech_first_person'],
    ['I did it myself.', 'person-grace', 'owner_reflexive'],
    ["Tell Grace I'm running late.", 'person-grace', 'recipient_named_as_third_party'],
    ['اتصل على المطعم', 'person-grace', 'unverifiable_language'],
    ['Akşam yemeği hazır', 'person-grace', 'unverifiable_language'],
  ])('unresolvable %j → 422 with a truthful refusal; nothing saved, no model call', async (instruction, assignee, reason) => {
    const calls = router();
    const r = res();
    await automationsHandler(req('POST', oneTime({ instruction, assignee_id: assignee, automation_type: 'message' })), r);
    expect(r.statusCode).toBe(422);
    expect(r.payload).toMatchObject({ code: 'owner_perspective_unresolved', reason });
    expect(r.payload.error).toMatch(/^I didn't save that automation for (Grace|Loulya)\./);
    expect(writes(calls, 'automations', 'POST')).toHaveLength(0);
    noModel(calls);
  });

  it('an owner-only automation (no recipient) is not recipient-facing and is saved unchanged', async () => {
    const calls = router();
    const r = res();
    await automationsHandler(req('POST', oneTime({ instruction: 'Call my dentist.' })), r);
    expect(r.statusCode).toBe(201);
    expect(writes(calls, 'automations', 'POST')[0].body.instruction).toBe('Call my dentist.');
  });

  it('PATCH re-resolves when the words change; an unresolvable edit is refused and nothing is written', async () => {
    let calls = router();
    let r = res();
    await automationsHandler(req('PATCH', { id: 'auto-1', instruction: 'Wait for me at the door.' }), r);
    expect(writes(calls, 'automations', 'PATCH')[0].body.instruction).toBe('Wait for Sana at the door.');

    calls = router();
    r = res();
    await automationsHandler(req('PATCH', { id: 'auto-1', instruction: 'Grace said I would come.', assignee_id: 'person-loulya' }), r);
    expect(r.statusCode).toBe(422);
    expect(writes(calls, 'automations', 'PATCH')).toHaveLength(0);
  });
});

describe('send time — rows saved before creation-time resolution cannot bypass the boundary', () => {
  const now = new Date('2026-10-03T08:00:00.000Z');
  const row = (overrides) => ({
    id: 'auto-1', user_id: 'user-1', title: 'A', cadence_type: 'once', cadence_value: {}, timezone: 'UTC',
    next_run_at: '2026-10-03T08:00:00.000Z', assignee_id: 'person-grace', ...overrides,
  });

  it('one-time message automation: an old raw "call me" is sent resolved', async () => {
    const calls = router();
    const result = await processMessageAutomation({ automation: row({ automation_type: 'message', instruction: 'Call me when you arrive.' }),
      supabaseUrl: SUPABASE, serviceKey: 'service-key', appBaseUrl: APP, runId: 'run-1', now });
    expect(result).toBe('ok');
    expect(sends(calls)[0].body.messageText).toBe('Call Sana when you arrive.');
    noModel(calls);
  });

  it.each(['Grace said I would call back.', 'اتصل على المطعم'])(
    'one-time message automation: unresolvable %j is NOT sent; run failed, automation paused, never marked delivered', async (instruction) => {
      const calls = router();
      const result = await processMessageAutomation({ automation: row({ automation_type: 'message', instruction }),
        supabaseUrl: SUPABASE, serviceKey: 'service-key', appBaseUrl: APP, runId: 'run-1', now });
      expect(result).toBe('failed');
      expect(sends(calls)).toHaveLength(0);
      const runPatch = calls.find((c) => c.url.includes('/rest/v1/automation_runs') && c.method === 'PATCH');
      expect(runPatch.body).toMatchObject({ current_state: 'failed' });
      expect(runPatch.body.failure_reason).toMatch(/^Not sent:/);
      const autoPatch = writes(calls, 'automations', 'PATCH');
      expect(autoPatch).toHaveLength(1);
      expect(autoPatch[0].body).toMatchObject({ status: 'paused' });
      expect(autoPatch[0].body.paused_reason).toMatch(/^Not sent:/);
      expect(JSON.stringify(calls.map((c) => c.body))).not.toMatch(/delivered|sent_at|completed/);
      noModel(calls);
    });

  it('one-time delegation automation: stored task description and WhatsApp text are the resolved text', async () => {
    const calls = router();
    await processAutomation({ automation: row({ automation_type: 'delegation', instruction: 'Bring my bag to the car.' }),
      supabaseUrl: SUPABASE, serviceKey: 'service-key', appBaseUrl: APP, now });
    expect(writes(calls, 'tasks', 'POST')[0].body).toMatchObject({ description: "Bring Sana's bag to the car.", type: 'delegation', assigned_to: 'Grace' });
    expect(sends(calls)[0].body.messageText).toBe("Bring Sana's bag to the car.");
    noModel(calls);
  });

  it('one-time delegation automation: unresolvable old text creates no task and sends nothing', async () => {
    const calls = router();
    const result = await processAutomation({ automation: row({ automation_type: 'delegation', instruction: 'Tell Grace I am late.' }),
      supabaseUrl: SUPABASE, serviceKey: 'service-key', appBaseUrl: APP, now });
    expect(result).toBe('failed');
    expect(writes(calls, 'tasks', 'POST')).toHaveLength(0);
    expect(sends(calls)).toHaveLength(0);
    expect(writes(calls, 'automations', 'PATCH').some((c) => c.body.status === 'paused')).toBe(true);
  });
});

describe('legacy routines (creation frozen; enabled rows still run) — same boundary at send time', () => {
  function routinesRouter(routines) {
    const calls = router();
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (String(url).includes('/rest/v1/routines') && (init.method || 'GET') === 'GET') {
        calls.push({ url: String(url), method: 'GET', body: null });
        return json(routines);
      }
      return base(url, init);
    }));
    return calls;
  }
  const routine = (overrides) => ({
    id: 'routine-1', user_id: 'user-1', name: 'R', enabled: true, schedule: 'every_n_days', interval_days: 1,
    next_run_at: '2020-01-01T00:00:00.000Z', timezone: 'UTC', schedule_time: '08:00', ...overrides,
  });

  it('message routine: safe text is sent resolved', async () => {
    const calls = routinesRouter([routine({ type: 'message', payload: { person_id: 'person-grace', message: 'Call me when you arrive.' } })]);
    await runRoutinesCore({ supabaseUrl: SUPABASE, serviceKey: 'service-key', appBaseUrl: APP });
    expect(sends(calls)[0].body.messageText).toBe('Call Sana when you arrive.');
    noModel(calls);
  });

  it.each([
    ['message', 'Grace said I would call back.'],
    ['delegation', 'Tell Grace I am late.'],
    ['message', 'الغدا جاهز'],
  ])('%s routine with unresolvable %j: nothing sent, no task, routine disabled', async (type, message) => {
    const calls = routinesRouter([routine({ type, payload: { person_id: 'person-grace', message } })]);
    const stats = await runRoutinesCore({ supabaseUrl: SUPABASE, serviceKey: 'service-key', appBaseUrl: APP });
    expect(sends(calls)).toHaveLength(0);
    expect(writes(calls, 'tasks', 'POST')).toHaveLength(0);
    expect(writes(calls, 'routines', 'PATCH')[0].body).toEqual({ enabled: false });
    expect(stats).toMatchObject({ executed: 0, skipped: 1 });
    noModel(calls);
  });
});
