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
 * Idempotency contract (atomic — see 20260727_staff_escalation_owner_
 * notification_lease.sql):
 *  - claim_owner_escalation_notification is the single atomic guard for
 *    the Meta send itself. It is NOT a check-then-act read — it is a
 *    row-locked SQL UPDATE that only one concurrent caller can win. Two
 *    overlapping invocations for the same staff_message_id (e.g. Meta
 *    redelivering the same webhook while the first attempt is still
 *    in flight) can never both receive claimed:true, so at most one real
 *    Meta send ever happens per attempt.
 *  - Only 'sent' is terminal. 'not_attempted' and 'failed' are directly
 *    claimable; a 'sending' lease is claimable again only once its
 *    lease_until has passed (crash/stuck-attempt recovery). A live
 *    'sending' lease held by a concurrent caller is never claimable.
 *  - complete_owner_escalation_notification / fail_owner_escalation_
 *    notification both require the exact live claim_token — a stale token
 *    from a superseded attempt can never resolve a newer one.
 *  - claim_escalation_owner_decision (Phase A) remains separately
 *    idempotent for the escalation *row* itself (one row per
 *    staff_message_id) — the notification lease above guards the *send*,
 *    this guards the *escalation record*. Both together are what make a
 *    retry safe: at most one escalation row, at most one real Meta send.
 *
 * Success ordering (independent-review fix): the persistent 'sent' state
 * is recorded via complete_owner_escalation_notification FIRST — that
 * write is the idempotency guard itself. markWhatsappDeliveryAccepted
 * (best-effort bookkeeping in a separate table) runs AFTER, wrapped in its
 * own try/catch, so a bookkeeping failure can never leave the guard
 * unwritten and can never cause a resend on retry.
 */

import { findOwnerPhone } from './task-confirm.js';
import { sendMetaMessage, buildOwnerDecisionTemplatePayload, normalizeWhatsAppPhone } from './send-whatsapp-task.js';
import { beginWhatsappDelivery, markWhatsappDeliveryAccepted, markWhatsappDeliveryFailed, getMetaFailure } from './_whatsapp-delivery.js';

const OWNER_DECISION_TEMPLATE_NAME = 'ra7etbal_owner_decision';
const LEASE_SECONDS = 120;

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
 * @returns {Promise<{attempted: boolean, status: 'sent'|'skipped_no_phone'|'failed'|'in_progress', reason?: string, escalationId?: string, deepLinkToken?: string, notifiedAt?: string}>}
 */
export async function notifyOwnerOfEscalation(input, deps) {
  const fetchImpl = deps.fetchImpl || fetch;
  const { supabaseUrl, serviceKey } = deps;
  const { staffMessageId, userId, taskId, escalationReason, staffName } = input;

  let claim;
  try {
    claim = await rpc(supabaseUrl, serviceKey, fetchImpl, 'claim_owner_escalation_notification', {
      p_id: staffMessageId,
      p_user_id: userId,
      p_lease_seconds: LEASE_SECONDS,
    });
  } catch (err) {
    console.error('[escalation-notify] claim_owner_escalation_notification failed', { staffMessageId, error: err?.message || String(err) });
    return { attempted: false, status: 'failed', reason: 'claim_rpc_failed' };
  }

  if (!claim?.claimed) {
    // Already sent: treat as success, never resend. A live lease held by a
    // concurrent caller (this same message, overlapping redelivery): report
    // truthfully as in-progress — never claim a new successful contact
    // unless the stored state is genuinely 'sent'.
    if (claim?.notification_status === 'sent') {
      return { attempted: false, status: 'sent', reason: 'already_sent' };
    }
    return { attempted: false, status: 'in_progress', reason: 'lease_held_elsewhere' };
  }

  const claimToken = claim.claim_token;

  let escalation;
  try {
    escalation = await rpc(supabaseUrl, serviceKey, fetchImpl, 'claim_escalation_owner_decision', {
      p_staff_message_id: staffMessageId,
      p_user_id: userId,
      p_task_id: taskId || null,
    });
  } catch (err) {
    console.error('[escalation-notify] claim_escalation_owner_decision failed', { staffMessageId, error: err?.message || String(err) });
    await failLease(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, claimToken, 'escalation_claim_failed');
    return { attempted: true, status: 'failed', reason: 'claim_failed' };
  }

  const deepLinkToken = escalation?.deep_link_token;
  const escalationId = escalation?.id;
  if (!deepLinkToken || !escalationId) {
    await failLease(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, claimToken, 'no_deep_link_token');
    return { attempted: true, status: 'failed', reason: 'no_deep_link_token' };
  }

  const ownerPhone = await findOwnerPhone({ supabaseUrl, serviceKey, userId });
  if (!ownerPhone) {
    await failLease(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, claimToken, 'no_owner_phone_on_file');
    return { attempted: true, status: 'skipped_no_phone', escalationId, deepLinkToken };
  }

  const normalizedPhone = normalizeWhatsAppPhone(ownerPhone);
  if (!normalizedPhone) {
    await failLease(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, claimToken, 'invalid_owner_phone');
    return { attempted: true, status: 'skipped_no_phone', escalationId, deepLinkToken, reason: 'invalid_phone' };
  }

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    await failLease(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, claimToken, 'whatsapp_not_configured');
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
    }).catch(() => {});
    await failLease(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, claimToken, 'network_error');
    return { attempted: true, status: 'failed', reason: 'network_error', escalationId, deepLinkToken };
  }

  if (!sendResult.ok) {
    const failure = getMetaFailure(sendResult);
    await markWhatsappDeliveryFailed({ supabaseUrl, serviceKey, deliveryId, failureStage: 'meta_api', ...failure, templateName }).catch(() => {});
    await failLease(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, claimToken, 'meta_rejected');
    return { attempted: true, status: 'failed', reason: 'meta_rejected', escalationId, deepLinkToken };
  }

  // Meta genuinely accepted the message. Persist the terminal 'sent' state
  // FIRST — this write is the idempotency guard itself, so it must land
  // before any non-critical bookkeeping, not after.
  let completed;
  try {
    completed = await rpc(supabaseUrl, serviceKey, fetchImpl, 'complete_owner_escalation_notification', {
      p_id: staffMessageId,
      p_user_id: userId,
      p_claim_token: claimToken,
    });
  } catch (err) {
    // Meta already accepted the send — never report this as a failed
    // contact. Log loudly for follow-up; the lease will still expire and
    // become reclaimable, which is an accepted, narrow residual risk of
    // any lease-based design (matches the same tradeoff already accepted
    // for claim_staff_response_delivery / claim_escalation_answer_delivery).
    console.error('[escalation-notify] complete_owner_escalation_notification failed after a real Meta acceptance', {
      staffMessageId, error: err?.message || String(err),
    });
    return { attempted: true, status: 'sent', escalationId, deepLinkToken, notifiedAt: new Date().toISOString(), reason: 'sent_but_not_recorded' };
  }

  // Delivery bookkeeping runs AFTER the guard is safely recorded, and its
  // own failure must never undo the recorded 'sent' state or cause a resend.
  try {
    await markWhatsappDeliveryAccepted({
      supabaseUrl, serviceKey, deliveryId, metaMessageId: sendResult.messageId, templateName,
      metadata: { escalation_id: escalationId, staff_message_id: staffMessageId },
    });
  } catch (err) {
    console.warn('[escalation-notify] delivery acceptance bookkeeping failed (non-fatal, sent state already recorded)', {
      staffMessageId, deliveryId, error: err?.message || String(err),
    });
  }

  return { attempted: true, status: 'sent', escalationId, deepLinkToken, notifiedAt: completed.owner_notified_at };
}

async function failLease(supabaseUrl, serviceKey, fetchImpl, staffMessageId, userId, claimToken, reason) {
  try {
    await rpc(supabaseUrl, serviceKey, fetchImpl, 'fail_owner_escalation_notification', {
      p_id: staffMessageId,
      p_user_id: userId,
      p_claim_token: claimToken,
      p_error: reason,
    });
  } catch (err) {
    console.warn('[escalation-notify] fail_owner_escalation_notification failed (non-fatal)', {
      staffMessageId, reason, error: err?.message || String(err),
    });
  }
}

function buildEscalationMessage(staffName, escalationReason) {
  const reason = String(escalationReason || 'needs your decision').trim();
  const withName = staffName ? `${staffName}: ${reason}` : reason;
  return withName.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
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
