import sendWhatsappTask from './send-whatsapp-task.js';

const DIRECT_HINT = /\b(i(?:'m| am|’m)|i(?:'ll| will|’ll)|call (?:me|sana)|wait for (?:me|sana)|contact (?:me|sana)|bring (?:me|sana)|running late|be home)\b/i;
const WORK_HINT = /\b(clean|make|prepare|buy|pick up|take|bring|fix|wash|cook|organize|deliver)\b/i;
const MAX_COMMAND_LENGTH = 2000;

export function classifyOwnerCommand(text) {
  const input = String(text || '').trim();
  if (/^remind me\b/i.test(input)) {
    const timeText = input.match(/\btomorrow\s+at\s+(.+?)(?:[.!?]|$)/i)?.[1] || null;
    const body = input
      .replace(/^remind me\b/i, '')
      .replace(/\btomorrow(?:\s+at\s+.+?)?(?:[.!?]|$)/i, '')
      .replace(/^\s*to\s+/i, '')
      .replace(/[.!?]+$/, '')
      .trim();
    return { type: 'reminder', text: body || 'Reminder', tomorrow: /\btomorrow\b/i.test(input), timeText };
  }
  const directed = input.match(/^(?:tell|ask)\s+([A-Za-z][A-Za-z'’-]*)\s+(?:to\s+)?(.+)$/i);
  if (directed) {
    const [, recipient, instruction] = directed;
    const type = DIRECT_HINT.test(instruction) || !WORK_HINT.test(instruction) ? 'direct_message' : 'delegation';
    return { type, recipient, text: instruction.trim() };
  }
  return { type: 'unsupported', text: input };
}

export function normalizeOwnerReferences(text, ownerName) {
  const name = String(ownerName || '').trim() || 'the owner';
  return String(text || '')
    .replace(/\bcall me\b/gi, `call ${name}`)
    .replace(/\bwait for me\b/gi, `wait for ${name}`)
    .replace(/\bcontact me\b/gi, `contact ${name}`)
    .replace(/\bbring me\b/gi, `bring ${name}`)
    .replace(/\bmy\b/gi, `${name}'s`)
    .replace(/\bme\b/gi, name)
    .replace(/\bI\b/g, name);
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
    return {
      kind: 'unsupported',
      acknowledgement: 'I recorded this command, but this WhatsApp command type is not supported yet. I did not create or send anything.',
      acknowledgementAlreadyAccepted: row.acknowledgement_status === 'accepted',
    };
  }

  try {
    const ownerName = await resolveOwnerName(supabaseUrl, serviceKey, identity.userId);
    const result = classification.type === 'reminder'
      ? await executeReminder({ supabaseUrl, serviceKey, userId: identity.userId, receipt, row, classification })
      : await executePersonCommand({
          supabaseUrl, serviceKey, userId: identity.userId, receipt, row, classification, ownerName,
        });
    return { ...result, acknowledgementAlreadyAccepted: row.acknowledgement_status === 'accepted' };
  } catch (error) {
    await updateCommand(supabaseUrl, serviceKey, receipt, identity.userId, {
      execution_status: 'failed',
      execution_error: error?.message || String(error),
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    });
    return {
      kind: 'execution_failed',
      acknowledgement: 'I recorded your command, but I could not complete it. Nothing further was claimed as done; Ra7etBal will retry it safely.',
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
  const dueAt = parseReminderDue(classification);
  await insertOnce(supabaseUrl, serviceKey, 'tasks', {
    id: taskId, user_id: userId, description: classification.text, type: 'reminder',
    assigned_to: null, status: 'pending', needs_follow_up: false,
    confirmation_url: null, due_at: dueAt,
  });
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
    await insertOnce(supabaseUrl, serviceKey, 'tasks', {
      id: taskId, user_id: userId, description: normalizedText, type: 'delegation',
      assigned_to: person.name, status: 'pending', needs_follow_up: true,
      confirmation_url: confirmationLink, due_at: null,
    });
    sendMode = undefined;
  }

  await insertOnce(supabaseUrl, serviceKey, 'messages', {
    id: messageId, user_id: userId, task_id: taskId, recipient: person.name,
    content: messageText, confirmation_url: confirmationLink,
  });
  await updateCommand(supabaseUrl, serviceKey, receipt, userId, {
    execution_status: 'action_created', action_task_id: taskId, action_message_id: messageId,
    execution_result: { command_type: classification.type, recipient_id: person.id },
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

export async function reconcileOwnerWhatsappCommands({ supabaseUrl, serviceKey, limit = 20 }) {
  const rows = await select(supabaseUrl, serviceKey, 'owner_whatsapp_reply_receipts',
    `status=in.(failed,claimed)&execution_status=in.(failed,action_created)&next_retry_at=lte.${encodeURIComponent(new Date().toISOString())}` +
    `&retry_count=lt.5&select=*&order=next_retry_at.asc&limit=${limit}`);
  const results = [];
  for (const row of rows) {
    const claim = await rpcRows(supabaseUrl, serviceKey, 'claim_owner_whatsapp_reply', {
      p_user_id: row.user_id, p_external_message_id: row.external_message_id, p_lease_seconds: 120,
    });
    if (!claim.data?.[0]?.claimed) continue;
    const receipt = claim.data[0];
    const result = await persistAndExecuteOwnerCommand({
      supabaseUrl, serviceKey,
      identity: { userId: row.user_id, ownerPhone: row.sender_phone },
      msg: { body: row.inbound_text, phoneNumberId: row.phone_number_id },
      receipt,
    });
    results.push({ id: row.id, kind: result.kind });
  }
  return results;
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

function parseReminderDue({ tomorrow, timeText }) {
  if (!tomorrow) return null;
  const due = new Date();
  due.setDate(due.getDate() + 1);
  due.setHours(9, 0, 0, 0);
  const match = String(timeText || '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (match) {
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    if (match[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (match[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
    due.setHours(hour, minute, 0, 0);
  }
  return due.toISOString();
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

async function rpcRows(url, key, name, args) {
  const result = await rpcSingle(url, key, name, args);
  return { data: Array.isArray(result.data) ? result.data : [], error: result.error };
}

function headers(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}
