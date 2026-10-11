const AUTHORIZED_CONTEXTS = new WeakSet();
export function isAuthorizedWhatsappContext(context) { return AUTHORIZED_CONTEXTS.has(context); }
function authorized(context) { Object.freeze(context); AUTHORIZED_CONTEXTS.add(context); return context; }
const ALLOWED_SOURCE_TYPES = new Set([
  'delegation',
  'message',
  'followup',
  'routine_delegation',
  'routine_message',
  'automation_delegation',
  'automation_message',
  'image',
  'owner_reminder',
]);

/**
 * Creates a pending delivery row without ever blocking the actual send.
 * Ownership is derived from existing server-side records; caller-provided
 * user ids are intentionally unsupported.
 */
export async function beginWhatsappDelivery({
  supabaseUrl,
  serviceKey,
  messageRecordId,
  taskId,
  routineId,
  automationRunId,
  staffMessageId,
  personId,
  parentDeliveryId,
  sourceType,
  messageKind = 'template',
  recipientPhone,
  recipientName,
  templateName,
  metadata = {},
  authorizedContext,
}) {
  if (!supabaseUrl || !serviceKey) return null;

  try {
    if (authorizedContext && !isAuthorizedWhatsappContext(authorizedContext)) return null;
    const context = authorizedContext || await resolveDeliveryContext({
      supabaseUrl,
      serviceKey,
      messageRecordId,
      taskId,
      routineId,
      automationRunId,
      staffMessageId,
      explicitPersonId: personId,
    });
    if (!context?.userId) {
      console.warn('[whatsapp-delivery] skipped: no trusted owner context', {
        hasMessageRecordId: Boolean(messageRecordId),
        hasTaskId: Boolean(taskId),
        hasRoutineId: Boolean(routineId),
        hasAutomationRunId: Boolean(automationRunId),
        hasStaffMessageId: Boolean(staffMessageId),
      });
      return null;
    }

    const resolvedSourceType = ALLOWED_SOURCE_TYPES.has(sourceType)
      ? sourceType
      : context.taskId
        ? 'delegation'
        : 'message';

    const response = await fetch(`${supabaseUrl}/rest/v1/whatsapp_deliveries`, {
      method: 'POST',
      headers: {
        ...serviceHeaders(serviceKey),
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        user_id: context.userId,
        message_id: context.messageId,
        task_id: context.taskId,
        routine_id: context.routineId,
        automation_run_id: context.automationRunId,
        person_id: context.personId ?? null,
        parent_delivery_id: parentDeliveryId || null,
        source_type: resolvedSourceType,
        message_kind: messageKind === 'image' ? 'image' : 'template',
        recipient_phone: recipientPhone || null,
        recipient_name: recipientName || null,
        template_name: templateName || null,
        delivery_status: 'pending',
        metadata: isPlainObject(metadata) ? metadata : {},
      }),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      console.warn('[whatsapp-delivery] pending insert failed (send continues)', {
        status: response.status,
        details,
      });
      return null;
    }

    const rows = await response.json().catch(() => []);
    return Array.isArray(rows) ? rows[0]?.id ?? null : null;
  } catch (err) {
    console.warn('[whatsapp-delivery] pending insert threw (send continues)', {
      error: err?.message ?? String(err),
    });
    return null;
  }
}

/** S01: authorization is mandatory; delivery-ledger persistence remains best effort. */
export async function authorizeWhatsappOperation({ supabaseUrl, serviceKey, uid, internal, body }) {
  const deny = () => { throw new Error('whatsapp_authorization_denied'); };
  let resolvedOwnerId = internal ? null : uid;
  const read = async (table, filter, select = '*') => {
    const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${filter}&select=${encodeURIComponent(select)}&limit=2`, {
      headers: serviceHeaders(serviceKey),
    });
    if (!response.ok) throw new Error('whatsapp_authorization_unavailable');
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) throw new Error('whatsapp_authorization_unavailable');
    return rows;
  };
  const one = async (table, id) => {
    if (typeof id !== 'string' || !id.trim()) deny();
    const ownerFilter = resolvedOwnerId ? `&user_id=eq.${encodeURIComponent(resolvedOwnerId)}` : '';
    const rows = await read(table, `id=eq.${encodeURIComponent(id)}${ownerFilter}`);
    if (rows.length !== 1 || rows[0].id !== id || !rows[0].user_id || (resolvedOwnerId && rows[0].user_id !== resolvedOwnerId)) deny();
    resolvedOwnerId ||= rows[0].user_id;
    return rows[0];
  };
  if (!supabaseUrl || !serviceKey) throw new Error('whatsapp_authorization_unavailable');
  const mode = body.sendMode || 'task_template';
  if (!['task_template', 'direct_message', 'routine_message'].includes(mode)) deny();
  let message = body.messageRecordId ? await one('messages', body.messageRecordId) : null;
  let task = body.taskId ? await one('tasks', body.taskId) : null;
  const routine = body.routineId ? await one('routines', body.routineId) : null;
  const run = body.automationRunId ? await one('automation_runs', body.automationRunId) : null;
  const automation = run ? await one('automations', run.automation_id) : null;
  if (message?.task_id) {
    if (task && task.id !== message.task_id) deny();
    task ||= await one('tasks', message.task_id);
  }
  if (run?.task_id && (!task || task.id !== run.task_id)) deny();
  const records = [message, task, routine, run, automation].filter(Boolean);
  if (!records.length) deny();
  const userId = records[0].user_id;
  if (records.some(row => row.user_id !== userId) || (!internal && uid !== userId)) deny();
  if (mode === 'direct_message' && (!message || task || routine || run || message.confirmation_url)) deny();
  if (mode === 'task_template' && (!task || !task.assigned_to)) deny();
  if (mode === 'routine_message' && (task || (!routine && !run))) deny();
  const scoped = `user_id=eq.${encodeURIComponent(userId)}`;
  const storedPersonId = message?.person_id || routine?.payload?.person_id || automation?.assignee_id;
  let person;
  if (storedPersonId) person = await one('people', storedPersonId);
  else {
    const name = mode === 'task_template' ? task.assigned_to : message?.recipient;
    if (typeof name !== 'string' || !name.trim()) deny();
    // Exact persisted name, not a caller name, wildcard, suffix, or phone search.
    const rows = await read('people', `${scoped}&name=eq.${encodeURIComponent(name)}`);
    if (rows.length !== 1) deny();
    person = rows[0];
  }
  if (!person?.id || person.user_id !== userId || !person.phone) deny();
  const sameName = value => typeof value === 'string' && value.trim().toLowerCase() === String(person.name || '').trim().toLowerCase();
  if (task && !sameName(task.assigned_to)) deny();
  if (message && !sameName(message.recipient)) deny();
  if (routine?.payload?.person_id && routine.payload.person_id !== person.id) deny();
  if (automation && automation.assignee_id !== person.id) deny();
  if (body.personId && body.personId !== person.id) deny();
  if (body.recipientName && !sameName(body.recipientName)) deny();
  const phone = value => {
    if (typeof value !== 'string') return null;
    let digits = value.replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    return digits.length >= 7 ? digits : null;
  };
  const destination = phone(person.phone);
  if (!destination || (body.to != null && phone(body.to) !== destination)) deny();
  if (mode === 'task_template') {
    if (!task.confirmation_url || body.confirmationLink !== task.confirmation_url) deny();
    let link;
    try { link = new URL(task.confirmation_url); } catch { deny(); }
    if (link.protocol !== 'https:' || link.pathname !== '/confirm' || link.searchParams.get('task') !== task.id) deny();
    const configured = process.env.APP_BASE_URL || 'https://ra7etbal.com';
    let host;
    try { host = new URL(configured).hostname.replace(/^www\./, ''); } catch { deny(); }
    if (link.hostname.replace(/^www\./, '') !== host || link.username || link.password) deny();
  } else if (body.confirmationLink) deny();

  const permittedPaths = [];
  let referenceRows = [];
  if (task) {
    // This is authorization evidence: an unavailable read must not become an empty list.
    const response = await fetch(`${supabaseUrl}/rest/v1/task_attachments?task_id=eq.${encodeURIComponent(task.id)}&file_name=is.null&select=storage_path&order=sort_order.asc`, { headers: serviceHeaders(serviceKey) });
    if (!response.ok) throw new Error('whatsapp_authorization_unavailable');
    referenceRows = await response.json().catch(() => null);
    if (!Array.isArray(referenceRows)) throw new Error('whatsapp_authorization_unavailable');
    for (const row of referenceRows) permittedPaths.push(canonicalWhatsappImagePath(row.storage_path, userId));
    if (task.image_path) permittedPaths.push(canonicalWhatsappImagePath(task.image_path, userId));
    if (permittedPaths.some(path => !path)) deny();
  }
  const imagePath = body.imagePath ? canonicalWhatsappImagePath(body.imagePath, userId) : null;
  if (body.imagePath && !imagePath) deny();
  // Check every persisted attachment, including owner-inbound references, before any signing.
  const validatePath = async path => {
    if (task && path.startsWith(`${userId}/${task.id}/`)) return;
    const match = path.match(/^[^/]+\/whatsapp-inbound\/([^/]+)\.(jpg|png|webp)$/);
    if (!internal || !match) deny();
    const receipts = await read('owner_whatsapp_reply_receipts', `${scoped}&external_message_id=eq.${encodeURIComponent(match[1])}`);
    if (receipts.length !== 1 || receipts[0].user_id !== userId ||
        (message ? receipts[0].action_message_id !== message.id : receipts[0].action_task_id !== task?.id) ||
        (task && receipts[0].action_task_id !== task.id)) deny();
  };
  for (const path of new Set(permittedPaths)) await validatePath(path);
  if (imagePath && !permittedPaths.includes(imagePath)) {
    // A task-prefix alone is not evidence that an arbitrary object belongs to this operation.
    if (task && imagePath.startsWith(`${userId}/${task.id}/`)) deny();
    await validatePath(imagePath);
    permittedPaths.push(imagePath);
  }
  const count = referenceRows.length || (task?.image_path ? 1 : 0);
  if (body.attachmentCount != null && body.attachmentCount !== count) deny();
  return authorized({
    userId, personId: person.id, recipientName: person.name, destination,
    messageId: message?.id || null, taskId: task?.id || null,
    routineId: routine?.id || null, automationRunId: run?.id || null,
    imagePath, attachmentCount: count, attachmentPaths: Object.freeze(referenceRows.map(row => canonicalWhatsappImagePath(row.storage_path, userId))),
    permittedPaths: Object.freeze([...new Set(permittedPaths)]),
    sourceType: run ? (task ? 'automation_delegation' : 'automation_message') : routine ? (task ? 'routine_delegation' : 'routine_message') : task ? (body.sourceType === 'followup' ? 'followup' : 'delegation') : 'message',
  });
}

/** Exported image helper callers must prove the persisted evidence and owner destination too. */
export async function authorizeOwnerProofImage({ supabaseUrl, serviceKey, userId, taskId, staffMessageId, imagePath, to, fetchImpl = fetch }) {
  const denied = () => { throw new Error('whatsapp_authorization_denied'); };
  const read = async (table, filter, limit = 2) => {
    const response = await fetchImpl(`${supabaseUrl}/rest/v1/${table}?${filter}&select=*${limit == null ? '' : `&limit=${limit}`}`, { headers: serviceHeaders(serviceKey) });
    if (!response.ok) throw new Error('whatsapp_authorization_unavailable');
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) throw new Error('whatsapp_authorization_unavailable');
    return rows;
  };
  const path = canonicalWhatsappImagePath(imagePath, userId);
  if (!path || !supabaseUrl || !serviceKey || !taskId) denied();
  const scoped = `user_id=eq.${encodeURIComponent(userId)}`;
  const tasks = await read('tasks', `${scoped}&id=eq.${encodeURIComponent(taskId)}`);
  if (tasks.length !== 1 || tasks[0].id !== taskId || tasks[0].user_id !== userId || !path.startsWith(`${userId}/${taskId}/`)) denied();
  let permitted = canonicalWhatsappImagePath(tasks[0].proof_image_path, userId) === path;
  if (staffMessageId) {
    const staff = await read('staff_messages', `${scoped}&id=eq.${encodeURIComponent(staffMessageId)}`);
    if (staff.length !== 1 || staff[0].user_id !== userId || staff[0].task_id !== taskId) denied();
    const decisions = await read('staff_escalation_owner_decisions', `${scoped}&staff_message_id=eq.${encodeURIComponent(staffMessageId)}&task_id=eq.${encodeURIComponent(taskId)}`);
    if (decisions.length !== 1) denied();
    permitted = decisions.some(row => row.user_id === userId && row.task_id === taskId && row.staff_message_id === staffMessageId && canonicalWhatsappImagePath(row.proposed_photo_path, userId) === path);
  } else if (!permitted) {
    const rows = await read('task_attachments', `task_id=eq.${encodeURIComponent(taskId)}&file_name=eq.proof`, null);
    permitted = rows.some(row => row.task_id === taskId && canonicalWhatsappImagePath(row.storage_path, userId) === path);
  }
  if (!permitted) denied();
  const ownerRows = await read('people', scoped, null);
  const owners = ownerRows.filter(row => ['name', 'role'].some(field => typeof row[field] === 'string' && row[field].trim().toLowerCase() === 'boss'));
  if (owners.length !== 1 || owners[0].user_id !== userId || !owners[0].phone) denied();
  const phone = value => String(value || '').replace(/\D/g, '').replace(/^00/, '');
  const destination = phone(owners[0].phone);
  if (destination.length < 7 || phone(to) !== destination) denied();
  return authorized({ userId, taskId, destination, permittedPaths: Object.freeze([path]) });
}

/** No URL syntax, traversal, alternate percent encoding, or foreign tenant prefix. */
export function canonicalWhatsappImagePath(value, userId) {
  if (typeof value !== 'string' || !userId || /[%?#\\\x00-\x20]/.test(value)) return null;
  const path = value.startsWith('task-images/') ? value.slice('task-images/'.length) : value;
  const parts = path.split('/');
  if (parts.length < 3 || parts[0] !== userId || parts.some(part => !part || part === '.' || part === '..')) return null;
  return path;
}

export async function markWhatsappDeliveryAccepted({
  supabaseUrl,
  serviceKey,
  deliveryId,
  metaMessageId,
  templateName,
  metadata = {},
}) {
  const now = new Date().toISOString();
  await patchDeliveryFailOpen({
    supabaseUrl,
    serviceKey,
    deliveryId,
    fields: {
      delivery_status: 'accepted',
      meta_message_id: metaMessageId || null,
      template_name: templateName || null,
      accepted_at: now,
      last_status_at: now,
      failure_stage: null,
      failure_http_status: null,
      failure_code: null,
      failure_subcode: null,
      failure_reason: null,
      metadata: isPlainObject(metadata) ? metadata : {},
    },
    label: 'accepted update',
  });
}

export async function markWhatsappDeliveryFailed({
  supabaseUrl,
  serviceKey,
  deliveryId,
  failureStage,
  httpStatus,
  code,
  subcode,
  reason,
  templateName,
  metadata = {},
}) {
  const now = new Date().toISOString();
  await patchDeliveryFailOpen({
    supabaseUrl,
    serviceKey,
    deliveryId,
    fields: {
      delivery_status: 'failed',
      template_name: templateName || null,
      failed_at: now,
      last_status_at: now,
      failure_stage: failureStage || 'meta_api',
      failure_http_status: Number.isInteger(httpStatus) ? httpStatus : null,
      failure_code: code == null ? null : String(code),
      failure_subcode: subcode == null ? null : String(subcode),
      failure_reason: reason || 'WhatsApp delivery failed.',
      metadata: isPlainObject(metadata) ? metadata : {},
    },
    label: 'failed update',
  });
}

export function getMetaFailure(result) {
  const error = result?.metaError;
  return {
    httpStatus: Number.isInteger(result?.status) ? result.status : null,
    code: error?.code ?? null,
    subcode: error?.error_subcode ?? null,
    reason:
      error?.error_data?.details ||
      error?.message ||
      error?.title ||
      (typeof error?.raw === 'string' ? error.raw : null) ||
      'WhatsApp delivery failed.',
  };
}

async function resolveDeliveryContext({
  supabaseUrl,
  serviceKey,
  messageRecordId,
  taskId,
  routineId,
  automationRunId,
  staffMessageId,
  explicitPersonId,
}) {
  const lookups = [];

  if (messageRecordId) {
    lookups.push(
      fetchSingle({
        supabaseUrl,
        serviceKey,
        table: 'messages',
        id: messageRecordId,
        select: 'id,user_id,task_id,person_id',
      }).then((row) => ({
        kind: 'message',
        userId: row?.user_id ?? null,
        messageId: row?.id ?? null,
        taskId: row?.task_id ?? null,
        personId: row?.person_id ?? null,
      })),
    );
  }

  if (taskId) {
    lookups.push(
      fetchSingle({
        supabaseUrl,
        serviceKey,
        table: 'tasks',
        id: taskId,
        select: 'id,user_id',
      }).then((row) => ({
        kind: 'task',
        userId: row?.user_id ?? null,
        taskId: row?.id ?? null,
      })),
    );
  }

  if (routineId) {
    lookups.push(
      fetchSingle({
        supabaseUrl,
        serviceKey,
        table: 'routines',
        id: routineId,
        select: 'id,user_id',
      }).then((row) => ({
        kind: 'routine',
        userId: row?.user_id ?? null,
        routineId: row?.id ?? null,
      })),
    );
  }

  if (automationRunId) {
    lookups.push(
      fetchSingle({
        supabaseUrl,
        serviceKey,
        table: 'automation_runs',
        id: automationRunId,
        select: 'id,user_id,task_id',
      }).then((row) => ({
        kind: 'automation_run',
        userId: row?.user_id ?? null,
        automationRunId: row?.id ?? null,
        taskId: row?.task_id ?? null,
      })),
    );
  }

  if (staffMessageId) {
    lookups.push(
      fetchSingle({
        supabaseUrl,
        serviceKey,
        table: 'staff_messages',
        id: staffMessageId,
        select: 'id,user_id,task_id,person_id',
      }).then((row) => ({
        kind: 'staff_message',
        userId: row?.user_id ?? null,
        taskId: row?.task_id ?? null,
        personId: row?.person_id ?? null,
      })),
    );
  }

  if (lookups.length === 0) return null;

  const records = await Promise.all(lookups);
  if (records.some((record) => !record.userId)) return null;

  const userIds = [...new Set(records.map((record) => record.userId))];
  if (userIds.length !== 1) {
    console.warn('[whatsapp-delivery] linked records have mismatched owners', {
      kinds: records.map((record) => record.kind),
    });
    return null;
  }

  const message = records.find((record) => record.kind === 'message');
  const task = records.find((record) => record.kind === 'task');
  const routine = records.find((record) => record.kind === 'routine');
  const automationRun = records.find((record) => record.kind === 'automation_run');
  const staffMessage = records.find((record) => record.kind === 'staff_message');

  // staff_messages.id is never written into whatsapp_deliveries.message_id —
  // that column's FK targets public.messages, a different table. The
  // staff-message linkage is carried in metadata.staff_message_id (set by
  // the caller) instead; only task_id is safe to inherit from it here.
  const linkedTaskIds = [
    message?.taskId,
    task?.taskId,
    automationRun?.taskId,
    staffMessage?.taskId,
  ].filter(Boolean);
  if (new Set(linkedTaskIds).size > 1) {
    console.warn('[whatsapp-delivery] linked records reference different tasks');
    return null;
  }

  // Durable person identity — independent of task_id, never affected by
  // task deletion later. Only message and staff_message can carry it (task,
  // routine, and automation_run rows have no person_id column). If both are
  // present and disagree, fail safely: leave person_id null rather than
  // guessing which one is right — this must never silently misattribute.
  const linkedPersonIds = [message?.personId, staffMessage?.personId].filter(Boolean);
  const personIdSet = new Set(linkedPersonIds);
  if (personIdSet.size > 1) {
    console.warn('[whatsapp-delivery] linked records reference different people; leaving person_id null');
  }
  const derivedPersonId = personIdSet.size === 1 ? linkedPersonIds[0] : null;

  // The caller (e.g. the automation runner, which already resolves the
  // canonical assignee before sending) may supply personId directly —
  // never a second identity algorithm, just an explicit value from an
  // already-resolved identity. When both an explicit and a derived
  // (message/staff_message-linked) identity exist:
  //   - if they agree, use the shared value;
  //   - if they disagree, fail closed (null) rather than silently
  //     preferring either one — this is never guessed, and is logged with
  //     structured diagnostics only (ids/kinds, never message content).
  // When only one of the two exists, it is used as-is (preserves the
  // pre-existing derived-only behavior exactly when no explicit value is
  // passed at all).
  let personId;
  if (explicitPersonId && derivedPersonId) {
    personId = explicitPersonId === derivedPersonId ? explicitPersonId : null;
    if (personId === null) {
      console.warn('[whatsapp-delivery] explicit and derived person identity conflict; leaving person_id null', {
        sourceKinds: records.map((record) => record.kind),
      });
    }
  } else {
    personId = explicitPersonId || derivedPersonId || null;
  }

  return {
    userId: userIds[0],
    messageId: message?.messageId ?? null,
    taskId: linkedTaskIds[0] ?? null,
    routineId: routine?.routineId ?? null,
    automationRunId: automationRun?.automationRunId ?? null,
    personId,
  };
}

async function fetchSingle({ supabaseUrl, serviceKey, table, id, select }) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/${table}` +
      `?id=eq.${encodeURIComponent(id)}` +
      `&select=${encodeURIComponent(select)}` +
      `&limit=1`,
    { headers: serviceHeaders(serviceKey) },
  );
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function patchDeliveryFailOpen({
  supabaseUrl,
  serviceKey,
  deliveryId,
  fields,
  label,
}) {
  if (!supabaseUrl || !serviceKey) return;
  if (!deliveryId) {
    // Visible on purpose: a missing deliveryId here almost always means
    // beginWhatsappDelivery already failed/skipped earlier (logged there),
    // so this update was always going to be a silent no-op otherwise. This
    // never blocks or retries the send — the update was already skipped.
    console.warn(`[whatsapp-delivery] ${label} skipped: no deliveryId (audit row was not created)`);
    return;
  }
  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/whatsapp_deliveries?id=eq.${encodeURIComponent(deliveryId)}`,
      {
        method: 'PATCH',
        headers: {
          ...serviceHeaders(serviceKey),
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(fields),
      },
    );
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      console.warn(`[whatsapp-delivery] ${label} failed (send result unchanged)`, {
        deliveryId,
        status: response.status,
        details,
      });
    }
  } catch (err) {
    console.warn(`[whatsapp-delivery] ${label} threw (send result unchanged)`, {
      deliveryId,
      error: err?.message ?? String(err),
    });
  }
}

function serviceHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
