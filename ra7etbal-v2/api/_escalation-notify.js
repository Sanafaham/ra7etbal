/**
 * Phase B — owner WhatsApp notification for a staff escalation.
 *
 * Called from api/whatsapp-webhook.js's handleInboundStaffMessage, after
 * processStaffMessage has classified an inbound staff message as
 * escalating (user_facing_state = 'Needs You'), and before the staff-facing
 * reply is finalized and sent.
 *
 * Reuses existing production helpers rather than reimplementing Meta
 * delivery bookkeeping:
 *  - findOwnerPhone (api/task-confirm.js)
 *  - beginWhatsappDelivery / markWhatsappDeliveryAccepted /
 *    markWhatsappDeliveryFailed / getMetaFailure (api/_whatsapp-delivery.js)
 *  - sendMetaMessage / buildOwnerDecisionTemplatePayload /
 *    normalizeWhatsAppPhone (api/send-whatsapp-task.js)
 *
 * Idempotency contract:
 *  - staff_messages.owner_notification_status is the single source of
 *    truth for whether an owner notification has already succeeded. Every
 *    call re-reads it fresh (never trusts a caller-supplied value) — a
 *    duplicate webhook redelivery, a retry after a crash, or a retry after
 *    a prior failure all converge on the same live row.
 *  - claim_escalation_owner_decision (Phase A) is itself idempotent — one
 *    row per staff_message_id — so calling it again on retry never creates
 *    a second escalation and always returns the same deep_link_token.
 *  - Only owner_notification_status='sent' short-circuits before any RPC
 *    or Meta call. 'not_attempted', 'skipped_no_phone', and 'failed' are
 *    all treated as "safe to (re)attempt" — this is what makes a failed
 *    notification explicitly retryable without creating a second
 *    escalation or a second successful send.
 */

import { findOwnerPhone } from './task-confirm.js';
import { sendMetaMessage, buildOwnerDecisionTemplatePayload, normalizeWhatsAppPhone } from './send-whatsapp-task.js';
import { beginWhatsappDelivery, markWhatsappDeliveryAccepted, markWhatsappDeliveryFailed, getMetaFailure } from './_whatsapp-delivery.js';

const OWNER_DECISION_TEMPLATE_NAME = 'ra7etbal_owner_decision';

/**
 * @param {object} input
 * @param {string} input.staffMessageId
 * @param {string} input.userId
 * @param {string|null} [input.taskId]
 * @param {string|null} [input.escalationReason]
 * @param {string|null} [input.staffName]
 * @param {object} deps
 * @param {string} deps.supabaseUrl
 * @param {string} deps.serviceKey
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {Promise<{attempted: boolean, status: 'sent'|'skipped_no_phone'|'failed', reason?: string, escalationId?: string, deepLinkToken?: string, notifiedAt?: string}>}
 */
export async function notifyOwnerOfEscalation(input, deps) {
  const fetchImpl = deps.fetchImpl || fetch;
  const { supabaseUrl, serviceKey } = deps;
  const { staffMessageId, userId, taskId, escalationReason, staffName } = input;

  const [current] = await restSelect(
    supabaseUrl, serviceKey, fetchImpl, 'staff_messages',
    `id=eq.${encodeURIComponent(staffMessageId)}&user_id=eq.${encodeURIComponent(userId)}&select=owner_notification_status`,
  );
  if (current?.owner_notification_status === 'sent') {
    return { attempted: false, status: 'sent', reason: 'already_sent' };
  }

  let escalation;
  try {
    escalation = await rpc(supabaseUrl, serviceKey, fetchImpl, 'claim_escalation_owner_decision', {
      p_staff_message_id: staffMessageId,
      p_user_id: userId,
      p_task_id: taskId || null,
    });
  } catch (err) {
    console.error('[escalation-notify] claim_escalation_owner_decision failed', { staffMessageId, error: err?.message || String(err) });
    await markStaffMessageNotification(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, 'failed');
    return { attempted: true, status: 'failed', reason: 'claim_failed' };
  }

  const deepLinkToken = escalation?.deep_link_token;
  const escalationId = escalation?.id;
  if (!deepLinkToken || !escalationId) {
    await markStaffMessageNotification(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, 'failed');
    return { attempted: true, status: 'failed', reason: 'no_deep_link_token' };
  }

  const ownerPhone = await findOwnerPhone({ supabaseUrl, serviceKey, userId });
  if (!ownerPhone) {
    await markStaffMessageNotification(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, 'skipped_no_phone');
    return { attempted: true, status: 'skipped_no_phone', escalationId, deepLinkToken };
  }

  const normalizedPhone = normalizeWhatsAppPhone(ownerPhone);
  if (!normalizedPhone) {
    await markStaffMessageNotification(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, 'skipped_no_phone');
    return { attempted: true, status: 'skipped_no_phone', escalationId, deepLinkToken, reason: 'invalid_phone' };
  }

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    await markStaffMessageNotification(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, 'failed');
    return { attempted: true, status: 'failed', reason: 'not_configured', escalationId, deepLinkToken };
  }

  const templateName = (process.env.WHATSAPP_OWNER_DECISION_TEMPLATE || OWNER_DECISION_TEMPLATE_NAME).trim();
  const templateLanguage = (process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US').trim();
  const payload = buildOwnerDecisionTemplatePayload({
    to: normalizedPhone,
    message: buildEscalationMessage(staffName, escalationReason),
    templateName,
    templateLanguage,
    taskUuid: deepLinkToken,
  });

  const deliveryId = await beginWhatsappDelivery({
    supabaseUrl,
    serviceKey,
    taskId: taskId || null,
    sourceType: 'message',
    recipientPhone: normalizedPhone,
    recipientName: 'Owner',
    templateName,
    metadata: { escalation_id: escalationId, staff_message_id: staffMessageId },
  });

  let sendResult;
  try {
    sendResult = await sendMetaMessage({
      url: `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      accessToken,
      payload,
    });
  } catch (err) {
    await markWhatsappDeliveryFailed({
      supabaseUrl, serviceKey, deliveryId, failureStage: 'network',
      reason: err instanceof Error ? err.message : String(err), templateName,
    });
    await markStaffMessageNotification(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, 'failed');
    return { attempted: true, status: 'failed', reason: 'network_error', escalationId, deepLinkToken };
  }

  if (!sendResult.ok) {
    const failure = getMetaFailure(sendResult);
    await markWhatsappDeliveryFailed({ supabaseUrl, serviceKey, deliveryId, failureStage: 'meta_api', ...failure, templateName });
    await markStaffMessageNotification(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, 'failed');
    return { attempted: true, status: 'failed', reason: 'meta_rejected', escalationId, deepLinkToken };
  }

  await markWhatsappDeliveryAccepted({
    supabaseUrl, serviceKey, deliveryId, metaMessageId: sendResult.messageId, templateName,
    metadata: { escalation_id: escalationId, staff_message_id: staffMessageId },
  });

  const notifiedAt = new Date().toISOString();
  await markStaffMessageNotification(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, 'sent', notifiedAt);
  return { attempted: true, status: 'sent', escalationId, deepLinkToken, notifiedAt };
}

function buildEscalationMessage(staffName, escalationReason) {
  const reason = String(escalationReason || 'needs your decision').trim();
  const withName = staffName ? `${staffName}: ${reason}` : reason;
  return withName.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

async function markStaffMessageNotification(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, status, notifiedAt) {
  const body = { owner_notification_status: status };
  if (notifiedAt) body.owner_notified_at = notifiedAt;
  try {
    const response = await fetchImpl(
      `${supabaseUrl}/rest/v1/staff_messages?id=eq.${encodeURIComponent(staffMessageId)}&user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      console.warn('[escalation-notify] owner_notification_status update failed (non-fatal)', { staffMessageId, status, details });
    }
  } catch (err) {
    console.warn('[escalation-notify] owner_notification_status update threw (non-fatal)', {
      staffMessageId, status, error: err?.message || String(err),
    });
  }
}

async function restSelect(supabaseUrl, serviceKey, fetchImpl, table, query) {
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/${table}?${query}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!response.ok) throw new Error(`${table}_lookup_failed`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function rpc(supabaseUrl, serviceKey, fetchImpl, name, args) {
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.message || `${name}_failed`;
    const err = new Error(message);
    err.postgrestCode = data?.code || null;
    throw err;
  }
  return Array.isArray(data) ? data[0] : data;
}

export { buildEscalationMessage, OWNER_DECISION_TEMPLATE_NAME };
