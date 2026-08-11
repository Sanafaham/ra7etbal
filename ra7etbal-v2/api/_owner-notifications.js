const OWNER_NOTIFICATIONS_UNIQUE_CONSTRAINT = 'owner_notifications_user_event_key_key';

export async function getOrCreateOwnerNotification({
  supabaseUrl,
  serviceRoleKey,
  userId,
  eventKey,
  kind,
  title,
  body,
  occurredAt,
  targetType = null,
  targetId = null,
  targetUrl = null,
  metadata = {},
}) {
  const headers = supabaseHeaders(serviceRoleKey);
  const insertResponse = await fetch(`${supabaseUrl}/rest/v1/owner_notifications`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: userId,
      event_key: eventKey,
      kind,
      title,
      body,
      occurred_at: occurredAt,
      target_type: targetType,
      target_id: targetId,
      target_url: targetUrl,
      metadata,
    }),
  });
  const insertBody = await readJson(insertResponse);

  if (insertResponse.ok) {
    const row = Array.isArray(insertBody) ? insertBody[0] : null;
    if (!row) throw new Error('Owner notification insert returned no row.');
    return { notification: row, created: true };
  }

  if (!isExactDuplicate(insertResponse, insertBody)) {
    throw new Error(insertBody?.message || `Could not create owner notification (${insertResponse.status}).`);
  }

  const existingResponse = await fetch(
    `${supabaseUrl}/rest/v1/owner_notifications` +
      `?user_id=eq.${encodeURIComponent(userId)}` +
      `&event_key=eq.${encodeURIComponent(eventKey)}` +
      '&select=*&limit=1',
    { headers },
  );
  const existingBody = await readJson(existingResponse);
  if (!existingResponse.ok) {
    throw new Error(existingBody?.message || 'Could not load existing owner notification.');
  }
  const notification = Array.isArray(existingBody) ? existingBody[0] : null;
  if (!notification) throw new Error('Duplicate owner notification could not be loaded.');
  return { notification, created: false };
}

export function buildDueReminderNotification(task) {
  return {
    userId: task.user_id,
    eventKey: `reminder_due:${task.id}`,
    kind: 'reminder_due',
    title: 'Ra7etBal',
    body: task.description,
    occurredAt: task.due_at,
    targetType: 'task',
    targetId: task.id,
    targetUrl: '/updates?tab=todo',
    metadata: { task_type: 'reminder' },
  };
}

function isExactDuplicate(response, body) {
  if (response.status !== 409 || body?.code !== '23505') return false;
  const detail = `${body?.message || ''} ${body?.details || ''}`;
  return detail.includes(OWNER_NOTIFICATIONS_UNIQUE_CONSTRAINT);
}

async function readJson(response) {
  return response.json().catch(() => null);
}

function supabaseHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}
