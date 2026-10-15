import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, { sendProofImageMessage } from './send-whatsapp-task.js';
import { authorizeWhatsappOperation } from './_whatsapp-delivery.js';
const UID = 'owner-a';
const TASK = '00000000-0000-4000-8000-000000000001';
const LINK = `https://ra7etbal.com/confirm?task=${TASK}`;
const PHOTO = `task-images/${UID}/${TASK}/photo.jpg`;
const PHONE = '15551234567';
let db, effects, fetchMock, outage, ledgerFailure;
function response(data, status = 200) { return { ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data), arrayBuffer: async () => new Uint8Array([255,216,255,217]).buffer, headers: { get: () => 'image/jpeg' } }; }
beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://database.test'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-public'); vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'synthetic-meta');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'synthetic-number'); vi.stubEnv('CRON_SECRET', 'synthetic-cron');
  vi.stubEnv('APP_BASE_URL', 'https://ra7etbal.com'); vi.stubEnv('SMS_FALLBACK_ENABLED', 'true');
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'synthetic-sid'); vi.stubEnv('TWILIO_AUTH_TOKEN', 'synthetic-twilio'); vi.stubEnv('TWILIO_FROM_NUMBER', '+15550000000');
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  outage = null; ledgerFailure = false; effects = [];
  db = {
    tasks: [{ id: TASK, user_id: UID, assigned_to: 'Worker', confirmation_url: LINK, image_path: null, proof_image_path: `${UID}/${TASK}/proof/one.jpg` }],
    messages: [{ id: 'msg', user_id: UID, task_id: null, recipient: 'Worker', person_id: 'person' }],
    people: [{ id: 'person', user_id: UID, name: 'Worker', phone: PHONE }, { id: 'boss', user_id: UID, name: 'Boss', role: 'boss', phone: '15550000001' }],
    routines: [{ id: 'routine', user_id: UID, payload: { person_id: 'person' } }],
    automation_runs: [{ id: 'run', user_id: UID, task_id: null, automation_id: 'automation' }],
    automations: [{ id: 'automation', user_id: UID, assignee_id: 'person' }],
    task_attachments: [], account_deletion_requests: [], owner_whatsapp_reply_receipts: [],
    staff_messages: [{ id: 'staff', user_id: UID, task_id: TASK }],
    staff_escalation_owner_decisions: [{ user_id: UID, task_id: TASK, staff_message_id: 'staff', proposed_photo_path: `${UID}/${TASK}/proposal/one.jpg` }],
  };
  fetchMock = vi.fn(async (url, options = {}) => {
    const u = new URL(url);
    if (u.pathname === '/auth/v1/user') return response({ id: UID });
    if (u.pathname.includes('/storage/v1/object/sign/') && options.method === 'POST') { effects.push('sign'); return response({ signedURL: '/object/sign/task-images/photo?synthetic=1' }); }
    if (u.hostname === 'graph.facebook.com') { effects.push(u.pathname.endsWith('/media') ? 'meta-upload' : 'meta-send'); return response({ id: 'media', messages: [{ id: 'wamid.synthetic' }] }); }
    if (u.hostname === 'api.twilio.com') { effects.push('twilio'); return response({ sid: 'sms' }, 201); }
    if (u.pathname.startsWith('/storage/v1')) return response({});
    const table = u.pathname.split('/').at(-1);
    if (table === 'whatsapp_deliveries') return response(ledgerFailure ? {} : [{ id: 'delivery' }], ledgerFailure ? 503 : 200);
    if (options.method === 'PATCH') return response({});
    if (outage === table) return response({}, 503);
    if (!db[table]) throw new Error(`Unmocked offline read: ${table}`);
    let rows = db[table].filter(row => [...u.searchParams].every(([key, val]) => {
      if (val.startsWith('eq.')) return String(row[key]) === val.slice(3);
      if (val === 'is.null') return row[key] == null;
      if (key === 'or') return row.role === 'boss' || row.name === 'boss';
      return true;
    }));
    if (u.searchParams.get('limit')) rows = rows.slice(0, Number(u.searchParams.get('limit')));
    return response(rows);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function send(body, internal = false) {
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return value; } };
  await handler({ method: 'POST', headers: internal ? { 'x-ra7etbal-internal-secret': 'synthetic-cron' } : { authorization: 'Bearer synthetic-user' }, body }, res);
  return res;
}
const taskBody = () => ({ taskId: TASK, confirmationLink: LINK, to: PHONE, messageText: 'Do the saved work.' });
const directBody = () => ({ messageRecordId: 'msg', sendMode: 'direct_message', to: PHONE, messageText: 'Saved communication.' });
async function denied(body, internal = false) { const res = await send(body, internal); expect([403,503,409]).toContain(res.statusCode); expect(effects).toEqual([]); return res; }
describe('S01 real handler, persisted authorization and zero provider effects', () => {
  it.each([false,true])('rejects missing anchors for internal=%s', async internal => { await denied({ to: PHONE, messageText: 'No operation' }, internal); });
  it.each([false,true])('rejects a different destination for internal=%s', async internal => { await denied({ ...taskBody(), to: '15559999999' }, internal); });
  it('does not let an owned person alone authorize a send', async () => { await denied({ personId: 'person', to: PHONE, sendMode: 'routine_message', messageText: 'No operation' }); });
  it('rejects foreign task ownership', async () => { db.tasks[0].user_id = 'owner-b'; await denied(taskBody()); });
  it('rejects mixed-tenant internal references', async () => { db.messages[0].user_id = 'owner-b'; await denied({ ...taskBody(), messageRecordId: 'msg' }, true); });
  it('rejects different task linkage in an owned message', async () => { db.messages[0].task_id = 'other-task'; await denied({ ...taskBody(), messageRecordId: 'msg' }); });
  it('rejects a different same-tenant person', async () => { await denied({ ...taskBody(), personId: 'boss' }); });
  it('rejects a caller name inconsistent with the operation', async () => { await denied({ ...taskBody(), recipientName: 'Boss' }); });
  it('rejects ambiguous legacy assignee names', async () => { db.people.push({ ...db.people[0], id: 'duplicate' }); await denied(taskBody()); });
  it('rejects direct mode for a message linked to a task', async () => { db.messages[0].task_id = TASK; await denied(directBody()); });
  it('rejects routine mode used to strip delegation follow-through', async () => { await denied({ ...taskBody(), routineId: 'routine', sendMode: 'routine_message' }, true); });
  it('rejects a mismatched confirmation URL', async () => { await denied({ ...taskBody(), confirmationLink: 'https://attacker.test/confirm?task='+TASK }); });
  it.each(['tasks','people','task_attachments'])('denies unavailable %s evidence', async table => { outage = table; await denied(taskBody()); });
  it('rejects an automation with a foreign parent', async () => { db.automations[0].user_id = 'owner-b'; await denied({ sendMode: 'routine_message', automationRunId: 'run', to: PHONE, messageText: 'Scheduled' }, true); });
  it.each(['task-images/owner-b/task/photo.jpg', `task-images/${UID}/${TASK}/../photo.jpg`, `task-images/${UID}/${TASK}/%2e%2e/photo.jpg`, `task-images/${UID}/${TASK}/photo.jpg?token=x`, `task-images/${UID}/other-task/photo.jpg`, `task-images/${UID}/${TASK}/photo.jpg\\x`])('rejects unauthorized image %s', async imagePath => { await denied({ ...taskBody(), imagePath }); });
  it('preauthorizes additional images before primary send', async () => { db.tasks[0].image_path = PHOTO; db.task_attachments = [{ task_id: TASK, storage_path: PHOTO }, { task_id: TASK, storage_path: 'owner-b/other/photo.jpg' }]; await denied({ ...taskBody(), imagePath: PHOTO, attachmentCount: 2 }); });
  it('rejects foreign owner-inbound receipt linkage', async () => { const imagePath = `${UID}/whatsapp-inbound/wamid.in.jpg`; db.owner_whatsapp_reply_receipts = [{ user_id: UID, external_message_id: 'wamid.in', action_message_id: 'other', action_task_id: TASK }]; await denied({ ...taskBody(), messageRecordId: 'msg', imagePath }, true); });
  it('preserves account-deletion freeze', async () => { db.account_deletion_requests = [{ user_id: UID, status: 'in_progress' }]; await denied(taskBody()); });
  it.each([false,true])('sends an authorized task for internal=%s', async internal => { const res = await send(taskBody(),internal); expect(res.statusCode).toBe(200); expect(effects).toEqual(['meta-send']); });
  it('preserves direct communication without a task or confirmation link', async () => { const res = await send(directBody()); expect(res.statusCode).toBe(200); expect(res.body.sendMode).toBe('direct_message'); expect(effects).toEqual(['meta-send']); });
  it('preserves QI correction legacy saved recipient', async () => { db.messages[0].person_id = null; const res = await send({ ...directBody(), sourceType: 'quality_correction' }, true); expect(res.statusCode).toBe(200); });
  it('preserves routine message from saved payload identity', async () => { const res = await send({ routineId:'routine', sendMode:'routine_message', to:PHONE, messageText:'Recurring' },true); expect(res.statusCode).toBe(200); });
  it('uses canonical persisted routine and automation IDs with duplicate names', async () => { db.people.push({ ...db.people[0], id:'duplicate', phone:'15550000009' }); expect((await send({...taskBody(),routineId:'routine'},true)).statusCode).toBe(200); db.automation_runs[0].task_id=TASK; expect((await send({...taskBody(),automationRunId:'run',personId:'person'},true)).statusCode).toBe(200); });
  it('preserves persisted owner-inbound task image', async () => { db.tasks[0].image_path=`${UID}/whatsapp-inbound/wamid.in.jpg`; db.owner_whatsapp_reply_receipts=[{user_id:UID,external_message_id:'wamid.in',action_task_id:TASK}]; expect((await send({...taskBody(),imagePath:db.tasks[0].image_path,attachmentCount:1},true)).statusCode).toBe(200); });
  it('preserves routine delegation', async () => { const res = await send({ ...taskBody(), routineId:'routine' },true); expect(res.statusCode).toBe(200); });
  it('preserves automation message and delegation', async () => { expect((await send({ automationRunId:'run', sendMode:'routine_message', to:PHONE, messageText:'Scheduled' },true)).statusCode).toBe(200); db.automation_runs[0].task_id = TASK; expect((await send({ ...taskBody(), automationRunId:'run' },true)).statusCode).toBe(200); });
  it('preserves linked owner-inbound image path', async () => { db.owner_whatsapp_reply_receipts = [{ user_id: UID, external_message_id:'wamid.in', action_task_id:TASK }]; const res = await send({ ...taskBody(), imagePath:`task-images/${UID}/whatsapp-inbound/wamid.in.jpg` },true); expect(res.statusCode).toBe(200); expect(effects).toContain('sign'); expect(effects).toContain('meta-upload'); });
  it('keeps ledger outages distinct from valid authorization', async () => { ledgerFailure = true; expect((await send(taskBody())).statusCode).toBe(200); expect(effects).toEqual(['meta-send']); });
  it('authorizes all additional paths before signing and sending', async () => { db.tasks[0].image_path = PHOTO; db.task_attachments=[{task_id:TASK,storage_path:PHOTO},{task_id:TASK,storage_path:`${UID}/${TASK}/attachments/1.jpg`}]; expect((await send({...taskBody(),imagePath:PHOTO,attachmentCount:2})).statusCode).toBe(200); expect(effects.filter(x=>x==='sign')).toHaveLength(2); });
});
describe('S01 exported proof-image helper', () => {
  const input = () => ({ to:'15550000001', accessToken:'synthetic-meta',phoneNumberId:'synthetic-number',supabaseUrl:'https://database.test',serviceKey:'synthetic-service',userId:UID,taskId:TASK,imagePath:`${UID}/${TASK}/proof/one.jpg` });
  it('rejects missing context and a forged context without signing', async () => { expect((await sendProofImageMessage({ ...input(),taskId:null,authorizedContext:{userId:UID,permittedPaths:[input().imagePath]} })).sent).toBe(false); expect(effects).toEqual([]); });
  it('rejects a wrong owner destination', async () => { expect((await sendProofImageMessage({...input(),to:PHONE})).sent).toBe(false); expect(effects).toEqual([]); });
  it('accepts canonical bucket aliases for persisted proof attachments', async () => { db.tasks[0].proof_image_path=null; db.task_attachments=[{task_id:TASK,file_name:'proof',storage_path:`task-images/${UID}/${TASK}/proof/one.jpg`}]; expect((await sendProofImageMessage(input())).sent).toBe(true); });
  it('rejects ambiguous proposal evidence without signing', async () => { db.staff_escalation_owner_decisions.push({...db.staff_escalation_owner_decisions[0]}); expect((await sendProofImageMessage({...input(),staffMessageId:'staff',imagePath:`${UID}/${TASK}/proposal/one.jpg`})).sent).toBe(false); expect(effects).toEqual([]); });
  it('rejects an unrecorded same-task proof', async () => { expect((await sendProofImageMessage({...input(),imagePath:`${UID}/${TASK}/proof/other.jpg`})).sent).toBe(false); expect(effects).toEqual([]); });
  it('preserves trimmed case-insensitive owner identity', async () => { db.people[1].role='owner'; db.people[1].name=' Boss '; expect((await sendProofImageMessage(input())).sent).toBe(true); });
  it('sends a persisted proof to the unique owner', async () => { expect((await sendProofImageMessage(input())).sent).toBe(true); expect(effects).toEqual(['sign','meta-upload','meta-send']); });
  it('sends a persisted substitution proposal only to its owner', async () => { expect((await sendProofImageMessage({...input(),staffMessageId:'staff',imagePath:`${UID}/${TASK}/proposal/one.jpg`})).sent).toBe(true); });
});
