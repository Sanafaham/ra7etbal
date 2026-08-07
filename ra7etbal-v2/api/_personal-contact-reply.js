/**
 * Personal Contact Reply Relay.
 *
 * Scope: owner sends a direct personal WhatsApp through Carson to a known
 * family/personal contact (people.is_family = true) → that contact replies →
 * Carson safely correlates the reply to the outbound message → Carson relays
 * the reply to the owner as plain text.
 *
 * Structurally isolated from every staff path: this module is only ever
 * invoked from whatsapp-webhook.js at the exact point where a family sender
 * is identified, before any staff_messages/task/escalation/QI code runs. It
 * never imports from and is never imported by _staff-comms-engine.js,
 * _escalation-notify.js, or task-confirm.js.
 *
 * Correlation is decided atomically inside record_personal_contact_reply
 * (see the migration), serialized per (user_id, sender_phone) with
 * pg_advisory_xact_lock so two concurrent replies from the same person can
 * never both claim the same delivery. Eligibility for the "single recent
 * conversation" step is derived from the absence of a prior
 * personal_contact_replies row pointing at a given whatsapp_deliveries.id —
 * never from whatsapp_deliveries's own delivery_status, which reflects Meta
 * transport state (sent/delivered/read), not whether the conversation has
 * already received a reply.
 *
 * correlateReply() below is a separate, read-only, non-authoritative
 * heuristic reused by whatsapp-webhook.js to decide routing (consent vs.
 * relay) before this handler ever runs — it never persists anything, so it
 * needs no locking.
 */

import { sendMetaMessage } from './send-whatsapp-task.js';

const LOOKBACK_DAYS = 7;
const MAX_TEXT_LENGTH = 2000;
const MAX_RETRIES = 5;

/**
 * @param {object} params
 * @param {string} params.supabaseUrl
 * @param {string} params.serviceKey
 * @param {{ from: string, messageId: string, body: string, phoneNumberId: string, contextMessageId: string|null }} params.msg
 * @param {{ id: string, name: string, phone?: string }} params.person  Already-resolved sender (is_family === true).
 * @param {string} params.userId  Already-resolved household owner id.
 */
export async function handleInboundPersonalContactReply({ supabaseUrl, serviceKey, msg, person, userId }) {
  const inboundText = String(msg.body || '').trim().slice(0, MAX_TEXT_LENGTH);
  if (!inboundText) {
    // Media-only replies (e.g. a photo with no caption) are outside this
    // capability's scope — text relay only. Nothing is recorded or sent;
    // this is an explicit, documented limitation, not a silent failure path
    // for the text replies this capability targets.
    return { handled: false, reason: 'empty_reply_not_supported', route: 'personal_contact_reply' };
  }

  const senderPhone = normalizePhone(msg.from);

  let recorded;
  try {
    recorded = await recordReply({
      supabaseUrl, serviceKey, userId, personId: person.id, senderPhone,
      externalMessageId: msg.messageId, inboundText, contextMessageId: msg.contextMessageId,
    });
  } catch (error) {
    console.error('[personal_contact_reply] record failed', {
      messageId: msg.messageId, error: error?.message || String(error),
    });
    return { handled: false, reason: 'record_failed', route: 'personal_contact_reply' };
  }

  if (!recorded.newlyRecorded) {
    // Duplicate Meta webhook delivery for the same external_message_id.
    // First-write-wins: already recorded (and, if applicable, already
    // notified) by an earlier delivery of this same event.
    console.log('[personal_contact_reply] duplicate inbound event, skipping', { messageId: msg.messageId });
    return { handled: true, reason: 'duplicate', route: 'personal_contact_reply' };
  }

  const correlation = { method: recorded.correlationMethod, deliveryId: recorded.correlatedDeliveryId };

  const ownerPhone = await resolveOwnerPhone(supabaseUrl, serviceKey, userId);
  if (!ownerPhone) {
    await completeNotification({
      supabaseUrl, serviceKey, userId, id: recorded.id, status: 'failed',
      text: null, transportMessageId: null,
    }).catch(() => {});
    return { handled: false, reason: 'owner_phone_unresolved', route: 'personal_contact_reply' };
  }

  const notificationText = buildOwnerNotificationText({
    personName: person.name, inboundText, correlation,
  });

  const send = await sendOwnerRelay({ phoneNumberId: msg.phoneNumberId, to: ownerPhone, text: notificationText });

  await completeNotification({
    supabaseUrl, serviceKey, userId, id: recorded.id,
    status: send.ok ? 'sent' : 'failed',
    text: notificationText,
    transportMessageId: send.messageId || null,
  }).catch(() => {});

  return {
    handled: send.ok,
    reason: send.ok ? 'relayed' : (send.reason || 'owner_notification_failed'),
    route: 'personal_contact_reply',
    correlationMethod: correlation.method,
  };
}

/**
 * Read-only, non-authoritative correlation check reused by
 * whatsapp-webhook.js to decide whether an opt-in-shaped short reply
 * ("yes"/"ok"/"sure") from a family member is more likely a reply to an
 * active direct personal conversation than a consent decision. Not used to
 * persist anything — record_personal_contact_reply recomputes this
 * atomically and authoritatively when the reply is actually recorded.
 */
export async function correlateReply({ supabaseUrl, serviceKey, userId, senderPhone, contextMessageId }) {
  if (contextMessageId) {
    const quoted = await restSelect(supabaseUrl, serviceKey, 'whatsapp_deliveries',
      `user_id=eq.${encodeURIComponent(userId)}&meta_message_id=eq.${encodeURIComponent(contextMessageId)}` +
      `&recipient_phone=eq.${encodeURIComponent(senderPhone)}` +
      `&metadata->>direct_message=eq.true&select=id&limit=2`);
    if (quoted.length === 1) return { method: 'quoted_context', deliveryId: quoted[0].id };
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const candidates = await restSelect(supabaseUrl, serviceKey, 'whatsapp_deliveries',
    `user_id=eq.${encodeURIComponent(userId)}&recipient_phone=eq.${encodeURIComponent(senderPhone)}` +
    `&metadata->>direct_message=eq.true&created_at=gte.${encodeURIComponent(since)}` +
    `&select=id,created_at&order=created_at.desc&limit=20`);
  if (candidates.length === 0) return { method: 'unmatched', deliveryId: null };

  const priorReplies = await restSelect(supabaseUrl, serviceKey, 'personal_contact_replies',
    `user_id=eq.${encodeURIComponent(userId)}` +
    `&correlated_delivery_id=in.(${candidates.map((c) => c.id).join(',')})` +
    `&select=correlated_delivery_id`);
  const alreadyReplied = new Set(priorReplies.map((r) => r.correlated_delivery_id));
  const eligible = candidates.filter((c) => !alreadyReplied.has(c.id));

  return eligible.length === 1
    ? { method: 'single_recent', deliveryId: eligible[0].id }
    : { method: 'unmatched', deliveryId: null };
}

/**
 * Sweeps failed owner-notification sends for retry. Reuses the exact
 * next_retry_at/retry_count pattern already used for owner-command receipts
 * (see markRetryable in _owner-command-executor.js and
 * reconcileOwnerWhatsappMessages in _owner-whatsapp-routing.js) — not a new
 * mechanism. Intended to be piggybacked onto the same already-scheduled
 * QStash cron sweep in process-delegation-escalations.js that already runs
 * reconcileOwnerWhatsappMessages.
 */
export async function reconcilePersonalContactReplyNotifications({ supabaseUrl, serviceKey, limit = 20 }) {
  const rows = await restSelect(supabaseUrl, serviceKey, 'personal_contact_replies',
    `owner_notification_status=eq.failed` +
    `&owner_notification_next_retry_at=lte.${encodeURIComponent(new Date().toISOString())}` +
    `&owner_notification_retry_count=lt.${MAX_RETRIES}` +
    `&select=id,user_id,person_id,sender_phone,inbound_text,correlation_method&limit=${limit}`);

  const results = [];
  for (const row of rows) {
    const [personName, phoneNumberId, ownerPhone] = await Promise.all([
      resolvePersonName(supabaseUrl, serviceKey, row.person_id),
      resolvePhoneNumberId(supabaseUrl, serviceKey, row.user_id),
      resolveOwnerPhone(supabaseUrl, serviceKey, row.user_id),
    ]);

    if (!phoneNumberId || !ownerPhone) {
      results.push({ id: row.id, ok: false, reason: 'missing_send_context' });
      continue;
    }

    const notificationText = buildOwnerNotificationText({
      personName, inboundText: row.inbound_text,
      correlation: { method: row.correlation_method },
    });

    const send = await sendOwnerRelay({ phoneNumberId, to: ownerPhone, text: notificationText });

    await completeNotification({
      supabaseUrl, serviceKey, userId: row.user_id, id: row.id,
      status: send.ok ? 'sent' : 'failed', text: notificationText,
      transportMessageId: send.messageId || null,
    }).catch(() => {});

    results.push({ id: row.id, ok: send.ok });
  }
  return results;
}

async function recordReply({ supabaseUrl, serviceKey, userId, personId, senderPhone, externalMessageId, inboundText, contextMessageId }) {
  const rows = await rpcRows(supabaseUrl, serviceKey, 'record_personal_contact_reply', {
    p_user_id: userId,
    p_person_id: personId,
    p_sender_phone: senderPhone,
    p_external_message_id: externalMessageId,
    p_inbound_text: inboundText,
    p_context_message_id: contextMessageId || null,
  });
  const row = rows[0];
  if (!row) throw new Error('record_personal_contact_reply_no_row');
  return {
    id: row.row_id,
    newlyRecorded: row.newly_recorded,
    ownerNotificationStatus: row.owner_notification_status,
    correlationMethod: row.correlation_method,
    correlatedDeliveryId: row.correlated_delivery_id,
  };
}

async function completeNotification({ supabaseUrl, serviceKey, userId, id, status, text, transportMessageId }) {
  await rpcRows(supabaseUrl, serviceKey, 'complete_personal_contact_reply_notification', {
    p_id: id,
    p_user_id: userId,
    p_status: status,
    p_notification_text: text,
    p_transport_message_id: transportMessageId,
  });
}

export function buildOwnerNotificationText({ personName, inboundText, correlation }) {
  const quoted = `${personName} replied: "${inboundText}"`;
  return correlation.method === 'unmatched'
    ? `${quoted} I couldn't safely match this to a recent message.`
    : quoted;
}

async function resolveOwnerPhone(supabaseUrl, serviceKey, userId) {
  const people = await restSelect(supabaseUrl, serviceKey, 'people',
    `user_id=eq.${encodeURIComponent(userId)}&select=id,name,role,phone`);
  const owner = people.find((p) => {
    const name = String(p.name || '').trim().toLowerCase();
    const role = String(p.role || '').trim().toLowerCase();
    return (name === 'boss' || role === 'boss') && p.phone;
  });
  return owner ? normalizePhone(owner.phone) : null;
}

async function resolvePersonName(supabaseUrl, serviceKey, personId) {
  if (!personId) return 'Unknown';
  const rows = await restSelect(supabaseUrl, serviceKey, 'people',
    `id=eq.${encodeURIComponent(personId)}&select=name&limit=1`);
  return rows[0]?.name || 'Unknown';
}

async function resolvePhoneNumberId(supabaseUrl, serviceKey, userId) {
  const rows = await restSelect(supabaseUrl, serviceKey, 'whatsapp_health_state',
    `user_id=eq.${encodeURIComponent(userId)}&select=phone_number_id&limit=1`);
  return rows[0]?.phone_number_id || null;
}

async function sendOwnerRelay({ phoneNumberId, to, text }) {
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
    return result.ok ? { ok: true, messageId: result.messageId } : { ok: false, reason: result.error || 'meta_rejected' };
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

async function rpcRows(url, key, name, args) {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`${name}_failed: ${details}`);
  }
  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? data : [data];
}
