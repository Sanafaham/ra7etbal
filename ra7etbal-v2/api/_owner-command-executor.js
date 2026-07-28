import sendWhatsappTask from './send-whatsapp-task.js';
import { normalizeFirstPersonForOwner } from '../shared/owner-reference-normalization.js';

const DIRECT_HINT = /\b(i(?:'m| am|’m)|i(?:'ll| will|’ll)|call (?:me|myself|sana)|wait for (?:me|myself|sana)|contact (?:me|myself|sana)|bring (?:me|myself|sana)|running late|be home)\b/i;
const WORK_HINT = /\b(clean|make|prepare|confirm|check|buy|pick up|take|fix|wash|cook|organize|deliver)\b/i;
const COMMAND_START = /\b(?:tell|ask)\s+[A-Za-z][A-Za-z'’-]*\b|\bremind\s+me\b/gi;
const MAX_COMMAND_LENGTH = 2000;
const MAX_RETRIES = 5;

export function classifyOwnerCommand(text) {
  const input = String(text || '').trim();
  const commandStarts = input.match(COMMAND_START) || [];
  if (commandStarts.length > 1) return { type: 'unsupported', text: input, reason: 'compound_command' };

  if (/^remind me\b/i.test(input)) {
    const temporal = input.match(
      /\b(next\s+(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|tomorrow(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b)/i,
    );
    if (!temporal) return { type: 'unsupported', text: input, reason: 'reminder_time_missing' };
    const body = input
      .replace(/^remind me\b/i, '')
      .replace(temporal[0], '')
      .replace(/^\s*to\s+/i, '')
      .replace(/\s+(?:and|then)\s*$/i, '')
      .replace(/[.!?]+$/, '')
      .trim();
    return { type: 'reminder', text: body || 'Reminder', timeText: temporal[0].trim() };
  }
  const directed = input.match(/^(?:tell|ask)\s+([A-Za-z][A-Za-z'’-]*)\s+(?:to\s+)?(.+)$/i);
  if (directed) {
    const [, recipient, instruction] = directed;
    if (/\b(?:and|then)\s+(?:tell|ask|remind)\b/i.test(instruction)) {
      return { type: 'unsupported', text: input, reason: 'compound_command' };
    }
    const type = DIRECT_HINT.test(instruction)
      ? 'direct_message'
      : WORK_HINT.test(instruction)
        ? 'delegation'
        : 'unsupported';
    return { type, recipient, text: instruction.trim() };
  }
  return { type: 'unsupported', text: input };
}

export function normalizeOwnerReferences(text, ownerName) {
  return normalizeFirstPersonForOwner(text, String(ownerName || '').trim() || 'the owner');
}

export async function persistAndExecuteOwnerCommand({
  supabaseUrl, serviceKey, identity, msg, receipt,
}) {
  const text = String(msg.body || '').trim().slice(0, MAX_COMMAND_LENGTH);
  const classification = classifyOwnerCommand(text);
  const recorded = await recordOwnerInbound({
    supabaseUrl, serviceKey, identity, msg, receipt, route: classification.type, text,
  });
  if (recorded.error) return { kind: 'execution_failed', message: 'I could not safely record this command, so I did not carry it out.', error: recorded.error.message };

  const row = recorded.data;
  if (classification.type === 'unsupported') {
    await updateCommand(supabaseUrl, serviceKey, receipt, identity.userId, {
      execution_status: 'unsupported',
      execution_result: { command_type: 'unsupported' },
    });
    const acknowledgement = 'I recorded this command, but this WhatsApp command type is not supported yet. I did not create or send anything.';
    return {
      kind: 'unsupported',
      acknowledgement,
      acknowledgementAlreadyAccepted:
        row.acknowledgement_status === 'accepted' && row.acknowledgement_text === acknowledgement,
    };
  }

  try {
    const ownerName = await resolveOwnerName(supabaseUrl, serviceKey, identity.userId);
    const result = classification.type === 'reminder'
      ? await executeReminder({ supabaseUrl, serviceKey, userId: identity.userId, receipt, row, classification })
      : await executePersonCommand({
          supabaseUrl, serviceKey, userId: identity.userId, receipt, row, classification, ownerName,
        });
    return {
      ...result,
      acknowledgementAlreadyAccepted:
        row.acknowledgement_status === 'accepted' && row.acknowledgement_text === result.acknowledgement,
    };
  } catch (error) {
    const parseFailed = error?.message === 'reminder_time_parse_failed';
    const exhausted = parseFailed ||
      Number(row.retry_count || 0) >= Number(row.max_retries || MAX_RETRIES);
    await updateCommand(supabaseUrl, serviceKey, receipt, identity.userId, {
      execution_status: exhausted ? 'terminal_failed' : 'failed',
      execution_error: error?.message || String(error),
      next_retry_at: exhausted ? null : new Date(Date.now() + 60_000).toISOString(),
    });
    const acknowledgement = parseFailed
      ? "I couldn't understand the reminder time, so nothing was scheduled."
      : exhausted
        ? 'I recorded your command, but I could not complete it after the allowed attempts. Nothing was claimed as done and no further retry is scheduled.'
        : 'I recorded your command, but I could not complete it. Nothing further was claimed as done; Ra7etBal will retry it safely.';
    return {
      kind: exhausted ? 'terminal_failed' : 'execution_failed',
      acknowledgement,
      acknowledgementAlreadyAccepted:
        row.acknowledgement_status === 'accepted' &&
        row.acknowledgement_text === acknowledgement,
      error: error?.message || String(error),
    };
  }
}

export async function recordOwnerInbound({
  supabaseUrl, serviceKey, identity, msg, receipt, route,
  text = String(msg.body || '').trim().slice(0, MAX_COMMAND_LENGTH),
}) {
  return rpcSingle(supabaseUrl, serviceKey, 'record_owner_whatsapp_command', {
    p_id: receipt.receipt_id,
    p_user_id: identity.userId,
    p_claim_token: receipt.claim_token,
    p_inbound_text: text,
    p_sender_phone: identity.ownerPhone,
    p_phone_number_id: msg.phoneNumberId,
    p_context_message_id: msg.contextMessageId || null,
    p_route: route,
  });
}

async function executeReminder({ supabaseUrl, serviceKey, userId, receipt, row, classification }) {
  const taskId = row.action_task_id || receipt.receipt_id;
  const timezone = await resolveOwnerTimezone(supabaseUrl, serviceKey, userId);
  const dueAt = parseOwnerReminderDue(classification.timeText, timezone);
  if (!dueAt) throw new Error('reminder_time_parse_failed');
  const inserted = await insertOnce(supabaseUrl, serviceKey, 'tasks', {
    id: taskId, user_id: userId, description: classification.text, type: 'reminder',
    assigned_to: null, status: 'pending', needs_follow_up: false,
    confirmation_url: null, due_at: dueAt,
  });
  const task = inserted[0] || (await select(
    supabaseUrl, serviceKey, 'tasks',
    `id=eq.${encodeURIComponent(taskId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,due_at,qstash_message_id&limit=1`,
  ))[0];
  if (!task || !sameInstant(task.due_at, dueAt)) throw new Error('reminder_task_state_mismatch');
  if (!task.qstash_message_id) {
    await scheduleReminderPush({ supabaseUrl, serviceKey, taskId, dueAt });
  }
  await updateCommand(supabaseUrl, serviceKey, receipt, userId, {
    execution_status: 'completed', action_task_id: taskId,
    execution_result: { command_type: 'reminder', reminder_id: taskId, due_at: dueAt },
  });
  return {
    kind: 'completed',
    acknowledgement: dueAt
      ? `Done — I created one reminder for ${formatDue(dueAt)}.`
      : 'Done — I created one reminder.',
  };
}

function sameInstant(left, right) {
  const leftMs = Date.parse(String(left || ''));
  const rightMs = Date.parse(String(right || ''));
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

async function executePersonCommand({ supabaseUrl, serviceKey, userId, receipt, row, classification, ownerName }) {
  const people = await select(supabaseUrl, serviceKey, 'people',
    `user_id=eq.${encodeURIComponent(userId)}&name=ilike.${encodeURIComponent(classification.recipient)}&select=id,name,phone,notes,whatsapp_opted_in&limit=2`);
  if (people.length !== 1) throw new Error('recipient_not_unique');
  const person = people[0];
  if (!person.phone || !person.whatsapp_opted_in) throw new Error('recipient_unreachable');

  const normalizedText = normalizeOwnerReferences(classification.text, ownerName);
  const messageId = row.action_message_id || receipt.receipt_id;
  let taskId = row.action_task_id || null;
  let confirmationLink = null;
  let messageText = normalizedText;
  let sendMode = 'direct_message';

  if (classification.type === 'delegation') {
    taskId ||= receipt.receipt_id;
    confirmationLink = `https://www.ra7etbal.com/confirm?task=${encodeURIComponent(taskId)}`;
    const inserted = await insertOnce(supabaseUrl, serviceKey, 'tasks', {
      id: taskId, user_id: userId, description: normalizedText, type: 'delegation',
      assigned_to: person.name, status: 'pending', needs_follow_up: true,
      confirmation_url: confirmationLink, due_at: null,
    });
    const task = inserted[0] || (await select(
      supabaseUrl, serviceKey, 'tasks',
      `id=eq.${encodeURIComponent(taskId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,created_at&limit=1`,
    ))[0];
    if (!task?.created_at) throw new Error('delegation_task_state_missing');
    if (row.execution_result?.escalation_scheduled !== true) {
      await scheduleEscalationMessages({ taskId, sentAt: task.created_at });
      await updateCommand(supabaseUrl, serviceKey, receipt, userId, {
        execution_status: 'action_created', action_task_id: taskId,
        execution_result: {
          command_type: classification.type,
          recipient_id: person.id,
          escalation_scheduled: true,
        },
      });
    }
    sendMode = undefined;
  }

  await insertOnce(supabaseUrl, serviceKey, 'messages', {
    id: messageId, user_id: userId, task_id: taskId, recipient: person.name,
    content: messageText, confirmation_url: confirmationLink,
  });
  await updateCommand(supabaseUrl, serviceKey, receipt, userId, {
    execution_status: 'action_created', action_task_id: taskId, action_message_id: messageId,
    execution_result: {
      command_type: classification.type,
      recipient_id: person.id,
      ...(classification.type === 'delegation' ? { escalation_scheduled: true } : {}),
    },
  });

  const existing = row.staff_transport_message_id
    ? [{ meta_message_id: row.staff_transport_message_id }]
    : await select(supabaseUrl, serviceKey, 'whatsapp_deliveries',
        `message_id=eq.${encodeURIComponent(messageId)}&delivery_status=in.(accepted,sent,delivered,read)&select=id,meta_message_id&limit=1`);
  let transportMessageId = existing[0]?.meta_message_id || null;
  if (!transportMessageId) {
    const response = await invokeSendWhatsappTask({
      to: person.phone, messageText, confirmationLink, messageRecordId: messageId,
      taskId, sourceType: classification.type === 'delegation' ? 'delegation' : 'message',
      sendMode, recipientName: person.name, ownerName,
    });
    if (!response.body?.success) throw new Error(response.body?.errorMessage || response.body?.error || 'staff_delivery_failed');
    transportMessageId = response.body.messageId || null;
  }

  await updateCommand(supabaseUrl, serviceKey, receipt, userId, {
    execution_status: 'completed', action_task_id: taskId, action_message_id: messageId,
    staff_transport_message_id: transportMessageId,
    execution_result: { command_type: classification.type, recipient_id: person.id, staff_delivery: 'accepted' },
  });
  return {
    kind: 'completed',
    acknowledgement: classification.type === 'delegation'
      ? `Done — I created the task for ${person.name} and WhatsApp accepted one delivery.`
      : `Done — I sent one direct message to ${person.name}. No task was created.`,
  };
}

export async function updateCommand(url, key, receipt, userId, fields) {
  const response = await fetch(`${url}/rest/v1/owner_whatsapp_reply_receipts?id=eq.${receipt.receipt_id}` +
    `&user_id=eq.${encodeURIComponent(userId)}&claim_token=eq.${receipt.claim_token}`, {
    method: 'PATCH', headers: { ...headers(key), Prefer: 'return=representation' }, body: JSON.stringify(fields),
  });
  const rows = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(rows) || rows.length !== 1) throw new Error('command_state_update_failed');
  return rows[0];
}

async function resolveOwnerName(url, key, userId) {
  const rows = await select(url, key, 'profiles', `id=eq.${encodeURIComponent(userId)}&select=display_name&limit=1`);
  return String(rows[0]?.display_name || '').trim() || 'the owner';
}

async function resolveOwnerTimezone(url, key, userId) {
  const rows = await select(
    url, key, 'profiles',
    `id=eq.${encodeURIComponent(userId)}&select=morning_brief_timezone&limit=1`,
  );
  return String(rows[0]?.morning_brief_timezone || '').trim() || 'Europe/Istanbul';
}

export function parseOwnerReminderDue(timeText, timezone, now = new Date()) {
  const input = String(timeText || '').trim().toLowerCase();
  if (!input || !isValidTimezone(timezone)) return null;
  const localNow = zonedParts(now, timezone);
  let daysToAdd = 0;
  let targetWeekday = null;
  if (/\btomorrow\b/.test(input)) daysToAdd = 1;
  const weekday = input.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekday) {
    targetWeekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(weekday[1]);
    daysToAdd = ((targetWeekday - weekdayFromDate(localNow.year, localNow.month, localNow.day) + 7) % 7) || 7;
  }
  const clock = input.match(/\b(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)?\b/);
  let hour = 9;
  let minute = 0;
  if (clock) {
    hour = Number(clock[1]);
    minute = Number(clock[2] || 0);
    const ampm = clock[3];
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (!ampm && hour >= 1 && hour <= 7) hour += 12;
  } else if (!/\btomorrow\b/.test(input) && targetWeekday === null) {
    return null;
  }
  let date = addCalendarDays(localNow.year, localNow.month, localNow.day, daysToAdd);
  let due = zonedDateToUtc({ ...date, hour, minute }, timezone);
  if (!/\btomorrow\b/.test(input) && targetWeekday === null && due.getTime() <= now.getTime() + 60_000) {
    date = addCalendarDays(localNow.year, localNow.month, localNow.day, 1);
    due = zonedDateToUtc({ ...date, hour, minute }, timezone);
  }
  return Number.isNaN(due.getTime()) ? null : due.toISOString();
}

function formatDue(iso) {
  return new Date(iso).toLocaleString('en', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
}

async function invokeSendWhatsappTask(body) {
  let statusCode = 200;
  let responseBody;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { responseBody = value; return value; },
  };
  await sendWhatsappTask({ method: 'POST', body, headers: {} }, res);
  return { statusCode, body: responseBody };
}

async function insertOnce(url, key, table, body) {
  const response = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headers(key), Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${table}_create_failed`);
  return response.json().catch(() => []);
}

export async function scheduleReminderPush({ supabaseUrl, serviceKey, taskId, dueAt }) {
  const messageId = await publishQstash({
    targetUrl: `${appBaseUrl()}/api/send-push-for-task`,
    notBefore: Math.ceil(new Date(dueAt).getTime() / 1000),
    dedupId: `reminder-${taskId}`,
    body: { taskId },
  });
  const response = await fetch(
    `${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: { ...headers(serviceKey), Prefer: 'return=minimal' },
      body: JSON.stringify({ qstash_message_id: messageId }),
    },
  );
  if (!response.ok) throw new Error('reminder_schedule_persist_failed');
}

export async function scheduleEscalationMessages({ taskId, sentAt }) {
  const sentMs = new Date(sentAt).getTime();
  if (Number.isNaN(sentMs)) throw new Error('invalid_delegation_sent_at');
  const targetUrl = `${appBaseUrl()}/api/process-delegation-escalations`;
  await Promise.all([
    publishQstash({
      targetUrl, notBefore: Math.floor((sentMs + 10 * 60_000) / 1000),
      dedupId: `followup-${taskId}`, body: { taskId },
    }),
    publishQstash({
      targetUrl, notBefore: Math.floor((sentMs + 20 * 60_000) / 1000),
      dedupId: `escalation-${taskId}`, body: { taskId },
    }),
  ]);
}

async function publishQstash({ targetUrl, notBefore, dedupId, body }) {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('qstash_not_configured');
  const response = await fetch(`https://qstash.upstash.io/v2/publish/${targetUrl}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Upstash-Not-Before': String(notBefore),
      'Upstash-Deduplication-Id': dedupId,
      'Upstash-Retries': '3',
      ...(process.env.CRON_SECRET
        ? { 'Upstash-Forward-Authorization': `Bearer ${process.env.CRON_SECRET}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.messageId) throw new Error('qstash_publish_failed');
  return data.messageId;
}

function appBaseUrl() {
  return String(process.env.APP_BASE_URL || 'https://www.ra7etbal.com').replace(/\/$/, '');
}

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function zonedParts(date, timezone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return values;
}

function zonedDateToUtc(parts, timezone) {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const observed = zonedParts(new Date(guess), timezone);
  const observedUtc = Date.UTC(
    observed.year, observed.month - 1, observed.day, observed.hour, observed.minute,
  );
  return new Date(guess - (observedUtc - guess));
}

function addCalendarDays(year, month, day, amount) {
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayFromDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

async function select(url, key, table, query) {
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, { headers: headers(key) });
  const rows = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(rows)) throw new Error(`${table}_lookup_failed`);
  return rows;
}

async function rpcSingle(url, key, name, args) {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(args),
  });
  const data = await response.json().catch(() => null);
  return response.ok ? { data, error: null } : { data: null, error: data || { message: `${name}_failed` } };
}

function headers(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}
