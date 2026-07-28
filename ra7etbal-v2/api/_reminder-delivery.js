import { createHmac, timingSafeEqual } from 'node:crypto';

export const CLIENT_RECEIPT_STAGES = new Set([
  'service_worker_received',
  'show_notification_attempted',
  'show_notification_resolved',
  'show_notification_failed',
  'notification_clicked',
]);

function receiptMessage({ taskId, userId, subscriptionId, dueAt }) {
  return [taskId, userId, subscriptionId, dueAt].join('\n');
}

export function signReminderReceipt(fields, secret) {
  if (!secret) throw new Error('Reminder receipt secret is not configured.');
  return createHmac('sha256', secret).update(receiptMessage(fields)).digest('base64url');
}

export function verifyReminderReceipt(fields, token, secret) {
  if (typeof token !== 'string' || !token || !secret) return false;
  const expected = signReminderReceipt(fields, secret);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function recordDeliveryEvent({
  supabaseUrl, serviceRoleKey, taskId, userId, subscriptionId = null,
  eventKey, stage, providerStatusCode = null, metadata = {},
}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/reminder_delivery_events`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify({
      task_id: taskId, user_id: userId, subscription_id: subscriptionId,
      event_key: eventKey, stage, provider_status_code: providerStatusCode, metadata,
    }),
  });
  if (!response.ok) throw new Error(`Could not record ${stage} (${response.status}).`);
}
