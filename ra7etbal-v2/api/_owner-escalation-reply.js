/**
 * Owner WhatsApp reply — correlation and resolution.
 *
 * Root cause this exists to fix: when the account owner replies directly on
 * WhatsApp (not through the app) to Carson's own escalation notification,
 * the inbound webhook had no owner-aware branch at all — the owner's reply
 * fell through into handleInboundStaffMessage (api/whatsapp-webhook.js),
 * which has no concept of "this sender is the household owner." It was
 * processed as a brand-new, unrelated staff message and produced a confused
 * clarification reply instead of resolving the open escalation.
 *
 * Called from api/whatsapp-webhook.js's handler(), BEFORE
 * handleInboundStaffMessage — this function must intercept an owner's
 * inbound message and return { isOwner: true, ... } so the caller never
 * falls through into staff processing for it. An owner's own reply must
 * never create a staff_messages row.
 *
 * Correlation order (approved design, no schema-driven guessing):
 *   1. Quoted-reply: msg.contextMessageId matched against
 *      whatsapp_deliveries.meta_message_id (the Meta message id of Carson's
 *      own Phase B owner-notification send — see api/_escalation-notify.js,
 *      which already records { escalation_id, staff_message_id } in that
 *      row's metadata). Deterministic — takes precedence over open-count
 *      regardless of how many other escalations are open, and is looked up
 *      by escalation id regardless of its current status (an already-
 *      resolved match is still safely handled by the idempotent shared
 *      Phase D helper below, never re-sent).
 *   2. No quoted-reply match: count this user's status='open' escalations.
 *      Exactly one → that is the target. Zero → truthful zero-match
 *      recovery reply. Two or more → concise clarification asking which
 *      one. Never default to "most recent."
 *   3. Once a target escalation is identified, the owner's own WhatsApp
 *      text becomes the exact instruction sent to staff — via the shared
 *      Phase D helper (resolveAndDeliverEscalationAnswer, extracted from
 *      api/task-confirm.js) with decision='custom_instruction'. The
 *      owner's literal words are never reinterpreted as yes/no and never
 *      rewritten — this is the same "custom instruction" contract already
 *      approved for the in-app decision UI, just reached from WhatsApp.
 *
 * Idempotency: every inbound owner WhatsApp message is claimed via
 * claim_owner_whatsapp_reply (20260727_owner_whatsapp_reply_receipts.sql)
 * BEFORE any correlation, classification, RPC call, or outbound send — a
 * Meta webhook redelivery of the same message can never be processed
 * twice. The receipt is marked 'completed' (with its outcome and matched
 * escalation, if any) immediately after correlation succeeds and BEFORE
 * the best-effort owner-facing WhatsApp reply is sent — same "durable
 * state first, non-critical send after" ordering already used by
 * _escalation-notify.js, so a failure sending the reply itself can never
 * cause the correlation/resolution to be silently lost or repeated. The
 * actual staff-facing delivery inside resolveAndDeliverEscalationAnswer
 * has its own, separate, already-proven exactly-once guarantee
 * (claim/complete/fail_escalation_answer_delivery) — this receipt only
 * protects the owner-reply-processing pass itself (correlation + the
 * owner-facing acknowledgement/clarification), not the staff send.
 */

import { findOwnerPhone, resolveAndDeliverEscalationAnswer, callRpcSingle, callRpcRows } from './task-confirm.js';
import { sendMetaMessage } from './send-whatsapp-task.js';

const RECEIPT_LEASE_SECONDS = 120;

const ZERO_MATCH_TEXT =
  "I couldn't match that reply to a pending staff question. Please reply directly to the WhatsApp message from me about it, or tell me which request you mean.";
const MULTIPLE_OPEN_TEXT =
  "You have more than one open staff question waiting on you right now. Please reply directly to the WhatsApp message for the one you mean, or tell me which staff member or task you're answering.";
const COULD_NOT_PROCESS_TEXT =
  "I couldn't process an answer for that request right now. Please open Ra7etBal to respond, or try again shortly.";
const EMPTY_REPLY_TEXT =
  "I couldn't read a reply to send. Please try again, or open Ra7etBal to respond.";
const COULD_NOT_DELIVER_TEXT =
  "I couldn't deliver that reply to the staff member right now. It's saved — please try again, or open Ra7etBal to respond.";

/**
 * @param {object} input
 * @param {string} input.supabaseUrl
 * @param {string} input.serviceKey
 * @param {object} input.msg  Same shape as extractInboundMessages() rows in whatsapp-webhook.js.
 * @returns {Promise<{isOwner: boolean, handled?: boolean, reason?: string}>}
 */
export async function handleInboundOwnerReply({ supabaseUrl, serviceKey, msg }) {
  const owners = await restSelect(supabaseUrl, serviceKey, 'whatsapp_health_state',
    `phone_number_id=eq.${encodeURIComponent(msg.phoneNumberId)}&select=user_id`);
  const userIds = [...new Set(owners.map((r) => r.user_id).filter(Boolean))];
  if (userIds.length !== 1) return { isOwner: false, reason: 'household_not_unique' };
  const userId = userIds[0];

  const sender = normalizePhone(msg.from);
  const ownerPhone = await findOwnerPhone({ supabaseUrl, serviceKey, userId }).catch(() => null);
  if (!sender || !ownerPhone || normalizePhone(ownerPhone) !== sender) {
    return { isOwner: false, reason: 'not_owner' };
  }

  // Claim the inbound receipt FIRST — before any correlation,
  // classification, RPC call, or outbound response.
  let receipt;
  try {
    const claimRows = await callRpcRows(supabaseUrl, serviceKey, 'claim_owner_whatsapp_reply', {
      p_user_id: userId,
      p_external_message_id: msg.messageId,
      p_lease_seconds: RECEIPT_LEASE_SECONDS,
    });
    if (claimRows.error) throw new Error(claimRows.error.message || 'claim_owner_whatsapp_reply_failed');
    receipt = claimRows.data[0];
  } catch (err) {
    console.error('[owner-escalation-reply] claim_owner_whatsapp_reply failed', {
      userId, messageId: msg.messageId, error: err?.message || String(err),
    });
    return { isOwner: true, handled: false, reason: 'claim_failed' };
  }

  if (!receipt.claimed) {
    // Either already fully completed, or a live lease is held elsewhere
    // (this exact message being processed concurrently) — do nothing
    // further. Never resend a clarification, a zero-match reply, or
    // resolve the escalation a second time.
    return {
      isOwner: true,
      handled: true,
      reason: receipt.status === 'completed' ? 'already_completed' : 'lease_held_elsewhere',
    };
  }

  let outcome;
  try {
    outcome = await correlateAndRespond({ supabaseUrl, serviceKey, userId, msg });
  } catch (err) {
    console.error('[owner-escalation-reply] correlation/resolution failed', {
      userId, messageId: msg.messageId, error: err?.message || String(err),
    });
    await failReceipt(supabaseUrl, serviceKey, userId, receipt, err?.message || String(err));
    return { isOwner: true, handled: false, reason: 'processing_failed' };
  }

  // Durable completion FIRST — before the best-effort owner-facing reply
  // send below. A failure sending the reply must never re-open this
  // message for reprocessing; a failure recording completion must never
  // let the reply go out without a durable record that it did.
  try {
    const completeResult = await callRpcSingle(supabaseUrl, serviceKey, 'complete_owner_whatsapp_reply', {
      p_id: receipt.receipt_id,
      p_user_id: userId,
      p_claim_token: receipt.claim_token,
      p_outcome: outcome.outcome,
      p_escalation_id: outcome.escalationId,
    });
    if (completeResult.error) throw new Error(completeResult.error.message || 'complete_owner_whatsapp_reply_failed');
  } catch (err) {
    console.error('[owner-escalation-reply] complete_owner_whatsapp_reply failed', {
      userId, messageId: msg.messageId, error: err?.message || String(err),
    });
    await failReceipt(supabaseUrl, serviceKey, userId, receipt, err?.message || String(err));
    return { isOwner: true, handled: false, reason: 'complete_failed' };
  }

  await sendOwnerReply({ supabaseUrl, serviceKey, phoneNumberId: msg.phoneNumberId, sender, text: outcome.replyText });
  return { isOwner: true, handled: true, reason: outcome.outcome };
}

async function correlateAndRespond({ supabaseUrl, serviceKey, userId, msg }) {
  let escalationRow = msg.contextMessageId
    ? await findEscalationByQuotedReply({ supabaseUrl, serviceKey, userId, contextMessageId: msg.contextMessageId })
    : null;

  let openRows = null;
  if (!escalationRow) {
    openRows = await fetchOpenEscalations({ supabaseUrl, serviceKey, userId });
    if (openRows.length === 1) escalationRow = openRows[0];
  }

  if (!escalationRow) {
    const zeroMatch = (openRows || []).length === 0;
    return {
      outcome: zeroMatch ? 'zero_match' : 'clarification_sent',
      escalationId: null,
      replyText: zeroMatch ? ZERO_MATCH_TEXT : MULTIPLE_OPEN_TEXT,
    };
  }

  // Same structural precondition the shared Phase D helper already
  // enforces (non-blank inbound_text) — resolved once here, reused for
  // both the reply-text builder and the recipient lookup inside it.
  const staffMessage = await fetchStaffMessage({ supabaseUrl, serviceKey, staffMessageId: escalationRow.staff_message_id });
  const staffContextText = typeof staffMessage?.inbound_text === 'string' ? staffMessage.inbound_text.trim() : '';
  if (!staffMessage || !staffContextText) {
    console.error('[owner-escalation-reply] could not resolve safe reply context', {
      escalationId: escalationRow.id, staffMessageId: escalationRow.staff_message_id,
    });
    return { outcome: 'clarification_sent', escalationId: escalationRow.id, replyText: COULD_NOT_PROCESS_TEXT };
  }

  const instructionText = String(msg.body || '').trim().slice(0, 1000);
  if (!instructionText) {
    return { outcome: 'clarification_sent', escalationId: escalationRow.id, replyText: EMPTY_REPLY_TEXT };
  }

  // The owner's own WhatsApp text is the instruction, verbatim — never
  // classified as yes/no, never rewritten. Safe and truthful regardless of
  // intent, and reuses the exact same "custom instruction" contract the
  // in-app decision UI already sends staff.
  const result = await resolveAndDeliverEscalationAnswer({
    supabaseUrl, serviceKey, userId,
    deepLinkToken: escalationRow.deep_link_token,
    escalation: escalationRow, staffMessage, staffContextText,
    decision: 'custom_instruction', instructionText,
  });

  if (result.kind !== 'success') {
    console.error('[owner-escalation-reply] resolveAndDeliverEscalationAnswer did not succeed', {
      escalationId: escalationRow.id, kind: result.kind, error: result.error, message: result.message,
    });
    return { outcome: 'clarification_sent', escalationId: escalationRow.id, replyText: COULD_NOT_DELIVER_TEXT };
  }

  const staffName = staffMessage.staff_name || 'the staff member';
  const replyText =
    result.status === 'saved_unreachable'
      ? `I've saved your reply, but I couldn't reach ${staffName} on WhatsApp right now.`
      : result.status === 'in_progress'
      ? `Got it — I'm sending that to ${staffName} now.`
      : `Got it — I've sent that to ${staffName}.`;

  return { outcome: 'resolved_escalation', escalationId: escalationRow.id, replyText };
}

async function findEscalationByQuotedReply({ supabaseUrl, serviceKey, userId, contextMessageId }) {
  const deliveries = await restSelect(supabaseUrl, serviceKey, 'whatsapp_deliveries',
    `user_id=eq.${encodeURIComponent(userId)}&meta_message_id=eq.${encodeURIComponent(contextMessageId)}&select=metadata&limit=1`);
  const escalationId = deliveries[0]?.metadata?.escalation_id;
  if (!escalationId) return null;
  const rows = await restSelect(supabaseUrl, serviceKey, 'staff_escalation_owner_decisions',
    `id=eq.${encodeURIComponent(escalationId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,user_id,staff_message_id,status,owner_reply_text,deep_link_token&limit=1`);
  return rows[0] || null;
}

async function fetchOpenEscalations({ supabaseUrl, serviceKey, userId }) {
  return restSelect(supabaseUrl, serviceKey, 'staff_escalation_owner_decisions',
    `user_id=eq.${encodeURIComponent(userId)}&status=eq.open&select=id,user_id,staff_message_id,status,owner_reply_text,deep_link_token&order=created_at.asc`);
}

async function fetchStaffMessage({ supabaseUrl, serviceKey, staffMessageId }) {
  const rows = await restSelect(supabaseUrl, serviceKey, 'staff_messages',
    `id=eq.${encodeURIComponent(staffMessageId)}&select=id,person_id,staff_name,staff_phone,inbound_text&limit=1`);
  return rows[0] || null;
}

async function failReceipt(supabaseUrl, serviceKey, userId, receipt, reason) {
  try {
    await callRpcSingle(supabaseUrl, serviceKey, 'fail_owner_whatsapp_reply', {
      p_id: receipt.receipt_id, p_user_id: userId, p_claim_token: receipt.claim_token, p_error: reason,
    });
  } catch (err) {
    console.error('[owner-escalation-reply] fail_owner_whatsapp_reply threw (non-fatal)', {
      receiptId: receipt.receipt_id, error: err?.message || String(err),
    });
  }
}

async function sendOwnerReply({ supabaseUrl, serviceKey, phoneNumberId, sender, text }) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken || !phoneNumberId) {
    console.error('[owner-escalation-reply] cannot send owner reply — WhatsApp not configured');
    return;
  }
  try {
    await sendMetaMessage({
      url: `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      accessToken,
      payload: { messaging_product: 'whatsapp', recipient_type: 'individual', to: sender, type: 'text', text: { body: text } },
    });
  } catch (err) {
    // Best-effort — the receipt is already durably completed above, so a
    // failure here is a lost reply, never a duplicate or lost resolution.
    console.error('[owner-escalation-reply] sendOwnerReply failed (non-fatal)', { error: err?.message || String(err) });
  }
}

function normalizePhone(value) { return String(value || '').replace(/\D/g, ''); }

async function restSelect(url, key, table, query) {
  const r = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`${table}_lookup_failed`);
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}
