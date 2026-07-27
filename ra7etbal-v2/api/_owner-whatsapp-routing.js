import {
  callRpcRows,
  callRpcSingle,
  resolveAndDeliverEscalationAnswer,
} from './task-confirm.js';
import { sendMetaMessage } from './send-whatsapp-task.js';

const RECEIPT_LEASE_SECONDS = 120;
const UNMATCHED_QUOTE_TEXT =
  "I couldn't identify the staff question you replied to. Please reply directly to the latest message about that request.";
const DELIVERY_FAILED_TEXT =
  "I saved your answer, but I couldn't deliver it to the staff member yet. Please try again shortly.";

/**
 * Safe owner WhatsApp boundary for Slice 1.
 *
 * A quoted Meta context id mapped to an owner-escalation notification is the
 * only escalation-answer authority. Every other owner message enters the
 * deliberately non-executing general-command path. Open-escalation count is
 * never queried and can never influence routing.
 */
export async function handleInboundOwnerMessage({ supabaseUrl, serviceKey, msg }) {
  let identity;
  try {
    identity = await resolveCanonicalOwner({ supabaseUrl, serviceKey, msg });
  } catch {
    // Fail closed. If account identity storage is unavailable, do not let a
    // possible owner message fall through into consent or staff side effects.
    return { isOwner: true, handled: false, route: 'identity_error', reason: 'identity_lookup_failed' };
  }
  if (!identity.isOwner) return identity;

  const receipt = await claimReceipt({
    supabaseUrl,
    serviceKey,
    userId: identity.userId,
    externalMessageId: msg.messageId,
  });
  if (!receipt.ok) {
    return { isOwner: true, handled: false, route: 'receipt_error', reason: receipt.reason };
  }
  if (!receipt.row.claimed) {
    return {
      isOwner: true,
      handled: true,
      route: 'duplicate',
      reason: receipt.row.status === 'completed' ? 'already_completed' : 'lease_held_elsewhere',
    };
  }

  if (!msg.contextMessageId) {
    const completed = await completeReceipt({
      supabaseUrl,
      serviceKey,
      userId: identity.userId,
      receipt: receipt.row,
      outcome: 'general_command_deferred',
      escalationId: null,
    });
    if (!completed) {
      return { isOwner: true, handled: false, route: 'general_command', reason: 'receipt_complete_failed' };
    }
    return {
      isOwner: true,
      handled: true,
      route: 'general_command',
      execution: 'not_implemented_in_slice_1',
    };
  }

  let escalation;
  try {
    escalation = await findQuotedEscalation({
      supabaseUrl,
      serviceKey,
      userId: identity.userId,
      contextMessageId: msg.contextMessageId,
    });
  } catch (error) {
    await failReceipt({ supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row, error });
    return { isOwner: true, handled: false, route: 'quoted_escalation', reason: 'correlation_failed' };
  }

  if (!escalation) {
    const ack = await sendOwnerAcknowledgement({
      phoneNumberId: msg.phoneNumberId,
      to: identity.ownerPhone,
      text: UNMATCHED_QUOTE_TEXT,
    });
    if (!ack.ok) {
      await failReceipt({
        supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
        error: ack.reason || 'owner_ack_failed',
      });
      return { isOwner: true, handled: false, route: 'unmatched_quote', reason: 'owner_ack_failed' };
    }
    const completed = await completeReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      outcome: 'clarification_sent', escalationId: null,
    });
    return {
      isOwner: true,
      handled: completed,
      route: 'unmatched_quote',
      reason: completed ? 'clarification_sent' : 'receipt_complete_failed',
    };
  }

  const staffMessage = await fetchStaffMessage({
    supabaseUrl,
    serviceKey,
    userId: identity.userId,
    staffMessageId: escalation.staff_message_id,
  });
  const staffContextText =
    typeof staffMessage?.inbound_text === 'string' ? staffMessage.inbound_text.trim() : '';
  const instructionText = String(msg.body || '').trim().slice(0, 1000);
  if (!staffMessage || !staffContextText || !instructionText) {
    await failReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      error: 'invalid_escalation_context',
    });
    return { isOwner: true, handled: false, route: 'quoted_escalation', reason: 'invalid_context' };
  }

  let result;
  try {
    result = await resolveAndDeliverEscalationAnswer({
      supabaseUrl,
      serviceKey,
      userId: identity.userId,
      deepLinkToken: escalation.deep_link_token,
      escalation,
      staffMessage,
      staffContextText,
      decision: 'custom_instruction',
      instructionText,
      replyChannel: 'whatsapp',
    });
  } catch (error) {
    await failReceipt({ supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row, error });
    return {
      isOwner: true,
      handled: false,
      route: 'quoted_escalation',
      reason: 'staff_delivery_failed',
      staffDelivery: 'processing_error',
    };
  }

  if (result.kind !== 'success') {
    await sendOwnerAcknowledgement({
      phoneNumberId: msg.phoneNumberId,
      to: identity.ownerPhone,
      text: DELIVERY_FAILED_TEXT,
    });
    await failReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      error: result.kind || 'staff_delivery_failed',
    });
    return {
      isOwner: true,
      handled: false,
      route: 'quoted_escalation',
      reason: 'staff_delivery_failed',
      staffDelivery: result.kind,
    };
  }

  const staffName = staffMessage.staff_name || 'the staff member';
  const acknowledgement =
    result.status === 'saved_unreachable'
      ? `I saved your answer, but I couldn't reach ${staffName} on WhatsApp yet.`
      : result.status === 'in_progress'
        ? `Got it — your answer to ${staffName} is already being delivered.`
        : result.status === 'sent_unconfirmed'
          ? `I sent your answer to ${staffName}, but delivery recording is still being reconciled.`
          : `Got it — I sent your answer to ${staffName}.`;
  const ack = await sendOwnerAcknowledgement({
    phoneNumberId: msg.phoneNumberId,
    to: identity.ownerPhone,
    text: acknowledgement,
  });
  if (!ack.ok) {
    await failReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      error: ack.reason || 'owner_ack_failed',
    });
    return {
      isOwner: true,
      handled: false,
      route: 'quoted_escalation',
      reason: 'owner_ack_failed',
      staffDelivery: result.status,
    };
  }

  const completed = await completeReceipt({
    supabaseUrl,
    serviceKey,
    userId: identity.userId,
    receipt: receipt.row,
    outcome: 'resolved_escalation',
    escalationId: escalation.id,
  });
  return {
    isOwner: true,
    handled: completed,
    route: 'quoted_escalation',
    reason: completed ? 'resolved_escalation' : 'receipt_complete_failed',
    staffDelivery: result.status,
  };
}

export async function resolveCanonicalOwner({ supabaseUrl, serviceKey, msg }) {
  const accounts = await restSelect(
    supabaseUrl,
    serviceKey,
    'whatsapp_health_state',
    `phone_number_id=eq.${encodeURIComponent(msg.phoneNumberId)}&select=user_id`,
  );
  const userIds = [...new Set(accounts.map((row) => row.user_id).filter(Boolean))];
  if (userIds.length !== 1) {
    return { isOwner: false, reason: 'account_not_unique' };
  }
  const userId = userIds[0];
  const people = await restSelect(
    supabaseUrl,
    serviceKey,
    'people',
    `user_id=eq.${encodeURIComponent(userId)}&select=id,name,role,phone`,
  );
  const ownerCandidates = people.filter((person) => {
    const name = String(person.name || '').trim().toLowerCase();
    const role = String(person.role || '').trim().toLowerCase();
    return (name === 'boss' || role === 'boss') && normalizePhone(person.phone);
  });
  if (ownerCandidates.length !== 1) {
    return { isOwner: false, reason: 'canonical_owner_not_unique' };
  }
  const sender = normalizePhone(msg.from);
  const ownerPhone = normalizePhone(ownerCandidates[0].phone);
  if (!sender || sender !== ownerPhone) {
    return { isOwner: false, reason: 'not_owner' };
  }
  return { isOwner: true, userId, ownerPhone };
}

async function findQuotedEscalation({ supabaseUrl, serviceKey, userId, contextMessageId }) {
  const deliveries = await restSelect(
    supabaseUrl,
    serviceKey,
    'whatsapp_deliveries',
    `user_id=eq.${encodeURIComponent(userId)}&meta_message_id=eq.${encodeURIComponent(contextMessageId)}` +
      '&recipient_name=eq.Owner&select=metadata&limit=2',
  );
  if (deliveries.length !== 1) return null;
  const escalationId = deliveries[0]?.metadata?.escalation_id;
  if (!escalationId) return null;
  const escalations = await restSelect(
    supabaseUrl,
    serviceKey,
    'staff_escalation_owner_decisions',
    `id=eq.${encodeURIComponent(escalationId)}&user_id=eq.${encodeURIComponent(userId)}` +
      '&select=id,user_id,staff_message_id,status,owner_reply_text,deep_link_token&limit=2',
  );
  return escalations.length === 1 ? escalations[0] : null;
}

async function fetchStaffMessage({ supabaseUrl, serviceKey, userId, staffMessageId }) {
  const rows = await restSelect(
    supabaseUrl,
    serviceKey,
    'staff_messages',
    `id=eq.${encodeURIComponent(staffMessageId)}&user_id=eq.${encodeURIComponent(userId)}` +
      '&select=id,user_id,person_id,staff_name,staff_phone,inbound_text&limit=2',
  );
  return rows.length === 1 ? rows[0] : null;
}

async function claimReceipt({ supabaseUrl, serviceKey, userId, externalMessageId }) {
  try {
    const result = await callRpcRows(supabaseUrl, serviceKey, 'claim_owner_whatsapp_reply', {
      p_user_id: userId,
      p_external_message_id: externalMessageId,
      p_lease_seconds: RECEIPT_LEASE_SECONDS,
    });
    if (result.error || !result.data?.[0]) {
      return { ok: false, reason: result.error?.message || 'receipt_claim_failed' };
    }
    return { ok: true, row: result.data[0] };
  } catch (error) {
    return { ok: false, reason: error?.message || 'receipt_claim_failed' };
  }
}

async function completeReceipt({ supabaseUrl, serviceKey, userId, receipt, outcome, escalationId }) {
  try {
    const result = await callRpcSingle(supabaseUrl, serviceKey, 'complete_owner_whatsapp_reply', {
      p_id: receipt.receipt_id,
      p_user_id: userId,
      p_claim_token: receipt.claim_token,
      p_outcome: outcome,
      p_escalation_id: escalationId,
    });
    if (!result.error) return true;
    await failReceipt({ supabaseUrl, serviceKey, userId, receipt, error: result.error.message });
    return false;
  } catch (error) {
    await failReceipt({ supabaseUrl, serviceKey, userId, receipt, error });
    return false;
  }
}

async function failReceipt({ supabaseUrl, serviceKey, userId, receipt, error }) {
  try {
    await callRpcSingle(supabaseUrl, serviceKey, 'fail_owner_whatsapp_reply', {
      p_id: receipt.receipt_id,
      p_user_id: userId,
      p_claim_token: receipt.claim_token,
      p_error: String(error?.message || error || 'processing_failed'),
    });
  } catch {
    // The original failure remains the actionable error; stale-token failure
    // here must not trigger a second side effect.
  }
}

async function sendOwnerAcknowledgement({ phoneNumberId, to, text }) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken || !phoneNumberId) return { ok: false, reason: 'whatsapp_not_configured' };
  try {
    const result = await sendMetaMessage({
      url: `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      accessToken,
      payload: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text },
      },
    });
    return result.ok
      ? { ok: true, messageId: result.messageId }
      : { ok: false, reason: result.error || 'meta_rejected' };
  } catch (error) {
    return { ok: false, reason: error?.message || 'network_error' };
  }
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

async function restSelect(url, key, table, query) {
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`${table}_lookup_failed`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}
