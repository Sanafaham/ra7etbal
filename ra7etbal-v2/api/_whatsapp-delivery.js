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
}) {
  if (!supabaseUrl || !serviceKey) return null;

  try {
    const context = await resolveDeliveryContext({
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
