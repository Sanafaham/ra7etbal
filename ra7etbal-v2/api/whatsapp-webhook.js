import { createHmac, timingSafeEqual } from 'node:crypto';
import { buildSmsBody, sendTwilioSms, sendMetaMessage } from './send-whatsapp-task.js';
import { sendOwnerPush } from './task-confirm.js';
import { processStaffMessage } from './_staff-comms-engine.js';

// One text-only Carson turn (WebSocket round trip to ElevenLabs) can run
// longer than the platform default. Matches the maxDuration already used by
// task-confirm.js and send-whatsapp-task.js for their own slow external
// calls. Existing delivery-status/consent handling is unaffected — it still
// completes in well under a second either way.
export const config = { maxDuration: 60, api: { bodyParser: false } };

const ALLOWED_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);
const DELIVERY_STATUS_RANK = {
  pending: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

// Normalised bodies that mean opt-in or opt-out.
const OPT_IN_REPLIES  = new Set(['yes', 'y', 'ok', 'okay', 'sure', 'start']);
const OPT_OUT_REPLIES = new Set(['stop', 'unsubscribe', 'cancel', 'quit', 'end']);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return verifyWebhook(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  const rawBody = await readRawBody(req);
  if (!verifyMetaSignature(rawBody, req.headers?.['x-hub-signature-256'], process.env.META_APP_SECRET)) {
    return res.status(401).json({ success: false, error: 'Invalid webhook signature.' });
  }
  let webhookBody;
  try { webhookBody = JSON.parse(rawBody.toString('utf8')); }
  catch { return res.status(400).json({ success: false, error: 'Invalid webhook payload.' }); }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const statuses        = extractStatuses(webhookBody);
  const inboundMessages = extractInboundMessages(webhookBody);
  const phoneNumberIds  = extractPhoneNumberIds(webhookBody);
  const webhookReceivedAt = new Date().toISOString();

  console.log('WhatsApp webhook POST received', {
    entries:         Array.isArray(webhookBody?.entry) ? webhookBody.entry.length : 0,
    statusCount:     statuses.length,
    inboundCount:    inboundMessages.length,
  });

  if (!supabaseUrl || !serviceKey) {
    console.error('WhatsApp webhook storage is not configured');
    return res.status(200).json({
      success: false,
      error: 'Webhook storage is not configured.',
    });
  }

  // Best-effort account heartbeat. Delivery logging must never interrupt
  // Meta's existing webhook handling or consent processing.
  await recordWebhookHeartbeat({
    supabaseUrl,
    serviceKey,
    phoneNumberIds,
    webhookReceivedAt,
    hasStatuses: statuses.length > 0,
  });

  // --- Process delivery status updates ---
  const statusResults = [];
  const deliveryResults = [];
  for (const item of statuses) {
    if (!ALLOWED_STATUSES.has(item.status)) {
      console.log('WhatsApp webhook ignored status', { messageId: item.messageId, status: item.status });
      continue;
    }
    const [messageResult, deliveryResult] = await Promise.all([
      updateMessageStatus({ supabaseUrl, serviceKey, ...item }),
      updateWhatsappDeliveryStatus({
        supabaseUrl,
        serviceKey,
        webhookReceivedAt,
        ...item,
      }),
    ]);
    statusResults.push(messageResult);
    deliveryResults.push(deliveryResult);
  }

  const failedStatuses = statusResults.filter((r) => !r.updated);
  if (failedStatuses.length > 0) {
    console.warn('WhatsApp webhook status update warnings', { failed: failedStatuses });
  }

  const failedDeliveryUpdates = deliveryResults.filter((r) => r.error);
  if (failedDeliveryUpdates.length > 0) {
    console.warn('WhatsApp delivery persistence warnings', { failed: failedDeliveryUpdates });
  }

  // --- Process inbound messages (consent replies, then the Carson bridge PoC) ---
  const consentResults = [];
  const staffResults = [];
  for (const msg of inboundMessages) {
    const result = await handleInboundConsentReply({ supabaseUrl, serviceKey, msg });
    consentResults.push(result);

    if (!result.handled && result.reason === 'not_consent_reply') {
      staffResults.push(await handleInboundStaffMessage({ supabaseUrl, serviceKey, msg }));
    }
  }

  return res.status(200).json({
    success:            true,
    statusProcessed:    statusResults.length,
    statusUpdated:      statusResults.filter((r) => r.updated).length,
    deliveryMatched:    deliveryResults.filter((r) => r.matched).length,
    deliveryUpdated:    deliveryResults.filter((r) => r.updated).length,
    consentHandled:     consentResults.filter((r) => r.handled).length,
    staffHandled:        staffResults.filter((r) => r.handled).length,
  });
}

export function verifyMetaSignature(rawBody, signature, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !appSecret || typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const supplied = signature.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const actual = Buffer.from(supplied, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody);
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function handleInboundStaffMessage({ supabaseUrl, serviceKey, msg }) {
  const phoneNumberId = msg.phoneNumberId;
  const owners = await restSelect(supabaseUrl, serviceKey, 'whatsapp_health_state',
    `phone_number_id=eq.${encodeURIComponent(phoneNumberId)}&select=user_id`);
  const userIds = [...new Set(owners.map((r) => r.user_id).filter(Boolean))];
  if (userIds.length !== 1) return { handled: false, reason: 'household_not_unique' };
  const userId = userIds[0];
  const people = await restSelect(supabaseUrl, serviceKey, 'people',
    `user_id=eq.${encodeURIComponent(userId)}&select=id,user_id,name,phone,role,is_family,whatsapp_opted_in,whatsapp_consent_at,whatsapp_consent_method`);
  const sender = normalizePhone(msg.from);
  const matches = people.filter((p) => normalizePhone(p.phone) === sender);
  if (!sender || matches.length !== 1) return { handled: false, reason: matches.length ? 'ambiguous_sender' : 'unknown_sender' };
  const person = matches[0];
  if (person.is_family) return { handled: false, reason: 'family_sender' };
  if (!person.whatsapp_opted_in || !person.whatsapp_consent_at || !person.whatsapp_consent_method) {
    return { handled: false, reason: 'not_opted_in' };
  }
  let taskId = null;
  if (msg.contextMessageId) {
    const contextualMessages = await restSelect(supabaseUrl, serviceKey, 'messages',
      `user_id=eq.${encodeURIComponent(userId)}&whatsapp_message_id=eq.${encodeURIComponent(msg.contextMessageId)}&select=task_id`);
    if (contextualMessages.length === 1) taskId = contextualMessages[0].task_id || null;
  }
  const existing = await restSelect(supabaseUrl, serviceKey, 'staff_messages',
    `user_id=eq.${encodeURIComponent(userId)}&source=eq.whatsapp&external_message_id=eq.${encodeURIComponent(msg.messageId)}&select=*`);
  const outcome = existing[0]?.processing_status === 'completed'
    ? { ok:true, messageId:existing[0].id, response:existing[0].carson_response }
    : await processStaffMessage({
        userId, personId: person.id, text: msg.body, taskId,
        threadId: msg.contextMessageId || null, receivedAt: timestampToIso(msg.timestamp),
        source:'whatsapp', externalMessageId:msg.messageId,
      }, { supabaseUrl, serviceKey, anthropicApiKey:process.env.ANTHROPIC_API_KEY });
  if (!outcome.ok || !outcome.response) return { handled:false, reason:'processing_failed' };
  const [claim] = await rpc(supabaseUrl, serviceKey, 'claim_staff_response_delivery',
    { p_id:outcome.messageId,p_user_id:userId,p_lease_seconds:120 });
  if (!claim?.claimed) return { handled:true, reason:'already_claimed' };
  const meta = await sendMetaMessage({
    url:`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
    accessToken:process.env.WHATSAPP_ACCESS_TOKEN,
    payload:{ messaging_product:'whatsapp',recipient_type:'individual',to:sender,type:'text',text:{body:claim.response_text} },
  }).catch((e)=>({ok:false,metaError:{message:e.message}}));
  if (meta.ok) {
    await rpc(supabaseUrl,serviceKey,'complete_staff_response_delivery',
      {p_id:outcome.messageId,p_user_id:userId,p_claim_token:claim.claim_token,p_transport_message_id:meta.messageId,p_delivered_at:new Date().toISOString()});
    return {handled:true,reason:'delivered'};
  }
  await rpc(supabaseUrl,serviceKey,'fail_staff_response_delivery',
    {p_id:outcome.messageId,p_user_id:userId,p_claim_token:claim.claim_token,p_error:'meta_delivery_failed',p_failed_at:new Date().toISOString()});
  return {handled:false,reason:'delivery_failed'};
}

function normalizePhone(value) { return String(value || '').replace(/\D/g, ''); }
async function restSelect(url,key,table,query) {
  const r=await fetch(`${url}/rest/v1/${table}?${query}`,{headers:serviceHeaders(key)});
  if(!r.ok) throw new Error(`${table}_lookup_failed`);
  const rows=await r.json().catch(()=>[]); return Array.isArray(rows)?rows:[];
}
async function rpc(url,key,name,args) {
  const r=await fetch(`${url}/rest/v1/rpc/${name}`,{method:'POST',headers:serviceHeaders(key),body:JSON.stringify(args)});
  if(!r.ok) throw new Error(`${name}_failed`);
  const rows=await r.json().catch(()=>[]); return Array.isArray(rows)?rows:[rows];
}

// ---------------------------------------------------------------------------
// Inbound message handler
// ---------------------------------------------------------------------------

async function handleInboundConsentReply({ supabaseUrl, serviceKey, msg }) {
  const { from, body, messageId, timestamp } = msg;
  const normalised = body.trim().toLowerCase().replace(/[^a-z]/g, '');

  const isOptIn  = OPT_IN_REPLIES.has(normalised);
  const isOptOut = OPT_OUT_REPLIES.has(normalised);

  if (!isOptIn && !isOptOut) {
    console.log('WhatsApp inbound: not a consent reply, ignoring', { from, body: body.slice(0, 50) });
    return { handled: false, from, reason: 'not_consent_reply' };
  }

  // Find person by normalised phone suffix match.
  const person = await findPersonByPhone({ supabaseUrl, serviceKey, rawPhone: from });
  if (!person) {
    console.warn('WhatsApp inbound: no person found for phone', { from });
    return { handled: false, from, reason: 'person_not_found' };
  }

  const event  = isOptIn ? 'opt_in' : 'opt_out';
  const now    = timestampToIso(timestamp);

  // Update people record.
  await updatePersonConsent({
    supabaseUrl,
    serviceKey,
    personId:  person.id,
    optedIn:   isOptIn,
    consentAt: isOptIn ? now : null,
    method:    isOptIn ? 'self_registered' : null,
  });

  // Write audit log row.
  await writeConsentLog({
    supabaseUrl,
    serviceKey,
    personId:      person.id,
    userId:        person.user_id,
    event,
    source:        'staff_reply',
    rawMessage:    body,
    whatsappMsgId: messageId,
    createdAt:     now,
  });

  console.log('WhatsApp consent updated from inbound reply', {
    from, event, personId: person.id, personName: person.name,
  });

  return { handled: true, from, event, personId: person.id };
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

export async function findPersonByPhone({ supabaseUrl, serviceKey, rawPhone }) {
  // rawPhone from Meta is digits only without leading +.
  // people.phone may be stored as "+971501234567", "00971...", or "0501234567".
  // We strip all non-digits and use a LIKE suffix match on the last 9 digits,
  // which avoids false matches while handling country-code variations.
  const digits = String(rawPhone).replace(/\D/g, '');
  if (digits.length < 7) return null;

  const suffix = digits.slice(-9); // last 9 digits are unique enough

  // is_family / whatsapp_opted_in are selected for the Carson bridge PoC's
  // staff-identity gate (api/_carson-agent-turn.js) — handleInboundConsentReply
  // below doesn't use them, so this is a purely additive widening.
  const response = await fetch(
    `${supabaseUrl}/rest/v1/people?select=id,user_id,name,phone,role,is_family,whatsapp_opted_in`,
    {
      headers: {
        apikey:        serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    },
  );

  if (!response.ok) {
    console.error('findPersonByPhone: fetch failed', { status: response.status });
    return null;
  }

  const people = await response.json().catch(() => []);
  if (!Array.isArray(people)) return null;

  for (const p of people) {
    const stored = String(p.phone || '').replace(/\D/g, '');
    if (stored.endsWith(suffix)) return p;
  }

  return null;
}

async function updatePersonConsent({ supabaseUrl, serviceKey, personId, optedIn, consentAt, method }) {
  const body = {
    whatsapp_opted_in:      optedIn,
    whatsapp_consent_at:    consentAt,
    whatsapp_consent_method: method,
  };

  const response = await fetch(
    `${supabaseUrl}/rest/v1/people?id=eq.${encodeURIComponent(personId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey:          serviceKey,
        Authorization:   `Bearer ${serviceKey}`,
        'Content-Type':  'application/json',
        Prefer:          'return=minimal',
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    console.error('updatePersonConsent: PATCH failed', { personId, status: response.status, details });
  }
}

async function writeConsentLog({
  supabaseUrl, serviceKey, personId, userId, event, source,
  rawMessage, whatsappMsgId, createdAt,
}) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/whatsapp_consent_log`,
    {
      method: 'POST',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify({
        person_id:       personId,
        user_id:         userId,
        event,
        source,
        raw_message:     rawMessage ?? null,
        whatsapp_msg_id: whatsappMsgId ?? null,
        created_at:      createdAt,
      }),
    },
  );

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    console.error('writeConsentLog: POST failed', { personId, event, status: response.status, details });
  }
}

async function updateMessageStatus({
  supabaseUrl,
  serviceKey,
  messageId,
  status,
  updatedAt,
  failureReason,
}) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/messages?whatsapp_message_id=eq.${encodeURIComponent(messageId)}&select=id`,
    {
      method: 'PATCH',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer:         'return=representation',
      },
      body: JSON.stringify({
        whatsapp_delivery_status:    status,
        whatsapp_status_updated_at:  updatedAt,
        whatsapp_failure_reason:     status === 'failed' ? failureReason : null,
      }),
    },
  );

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    return { updated: false, messageId, status, httpStatus: response.status, details };
  }

  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    return { updated: false, messageId, status, details: 'No message matched this WhatsApp message id.' };
  }

  console.log('WhatsApp delivery status updated', { messageId, status, updatedAt });
  return { updated: true, messageId, status, appMessageId: rows[0]?.id || null };
}

/**
 * Match a Meta status against the canonical delivery row and update it without
 * allowing out-of-order webhooks to regress delivery state.
 *
 * failed is terminal. Later sent/delivered/read events are ignored once failed.
 * Duplicate statuses may refresh last_status_at but never clear evidence.
 */
export async function updateWhatsappDeliveryStatus({
  supabaseUrl,
  serviceKey,
  messageId,
  status,
  updatedAt,
  failureReason,
  failureCode,
  failureSubcode,
  phoneNumberId,
  webhookReceivedAt = new Date().toISOString(),
  retryCount = 0,
}) {
  try {
    const lookupRes = await fetch(
      `${supabaseUrl}/rest/v1/whatsapp_deliveries` +
        `?meta_message_id=eq.${encodeURIComponent(messageId)}` +
        `&select=id,user_id,delivery_status,last_status_at,automation_run_id,source_type,recipient_phone,metadata` +
        `&limit=1`,
      { headers: serviceHeaders(serviceKey) },
    );
    if (!lookupRes.ok) {
      const details = await lookupRes.text().catch(() => '');
      return { matched: false, updated: false, error: 'lookup_failed', details };
    }

    const rows = await lookupRes.json().catch(() => []);
    const delivery = Array.isArray(rows) ? rows[0] ?? null : null;
    if (!delivery) {
      return { matched: false, updated: false, messageId, status };
    }

    await updateMatchedHealthState({
      supabaseUrl,
      serviceKey,
      userId: delivery.user_id,
      phoneNumberId,
      webhookReceivedAt,
      status,
    });

    const patch = buildDeliveryStatusPatch({
      currentStatus: delivery.delivery_status,
      incomingStatus: status,
      updatedAt,
      currentLastStatusAt: delivery.last_status_at,
      failureReason,
      failureCode,
      failureSubcode,
    });

    let updated = false;
    if (patch) {
      // Compare-and-swap prevents two concurrent webhook requests from
      // overwriting a state that changed after the lookup.
      const patchRes = await fetch(
        `${supabaseUrl}/rest/v1/whatsapp_deliveries` +
          `?id=eq.${encodeURIComponent(delivery.id)}` +
          `&delivery_status=eq.${encodeURIComponent(delivery.delivery_status)}` +
          `&select=id`,
        {
          method: 'PATCH',
          headers: {
            ...serviceHeaders(serviceKey),
            Prefer: 'return=representation',
          },
          body: JSON.stringify(patch),
        },
      );
      if (!patchRes.ok) {
        const details = await patchRes.text().catch(() => '');
        return {
          matched: true,
          updated: false,
          error: 'patch_failed',
          messageId,
          status,
          details,
        };
      }
      const updatedRows = await patchRes.json().catch(() => []);
      updated = Array.isArray(updatedRows) && updatedRows.length > 0;
      if (!updated && retryCount < 1) {
        // Another webhook advanced the row between lookup and patch. Re-read
        // once so the higher monotonic state wins rather than being dropped.
        return updateWhatsappDeliveryStatus({
          supabaseUrl,
          serviceKey,
          messageId,
          status,
          updatedAt,
          failureReason,
          failureCode,
          failureSubcode,
          phoneNumberId,
          webhookReceivedAt,
          retryCount: retryCount + 1,
        });
      }
    }

    // Propagate failure to automation_runs so the UI shows "Failed" instead of "Sent"
    if (updated && status === 'failed' && delivery.automation_run_id &&
        typeof delivery.source_type === 'string' && delivery.source_type.startsWith('automation_')) {
      try {
        await fetch(
          `${supabaseUrl}/rest/v1/automation_runs` +
          `?id=eq.${encodeURIComponent(delivery.automation_run_id)}`,
          {
            method: 'PATCH',
            headers: { ...serviceHeaders(serviceKey), Prefer: 'return=minimal' },
            body: JSON.stringify({
              current_state: 'failed',
              failure_reason: patch?.failure_reason ?? failureReason ?? 'WhatsApp delivery failed.',
            }),
          },
        );
        console.log('[whatsapp-webhook] automation_run marked failed', {
          automationRunId: delivery.automation_run_id,
        });
      } catch (err) {
        console.warn('[whatsapp-webhook] automation_run failure propagation threw', {
          automationRunId: delivery.automation_run_id,
          error: err?.message ?? String(err),
        });
      }
    }

    // SMS fallback for recurring message automations throttled by Meta
    // (131049 — "ecosystem engagement" pacing on the Marketing-category
    // ra7etbal_routine_message template). Reuses the existing Twilio path
    // from send-whatsapp-task.js's synchronous failure branch. Inert unless
    // SMS_FALLBACK_ENABLED is set — deploying this changes no behavior until
    // that flag is explicitly turned on.
    if (
      updated &&
      status === 'failed' &&
      delivery.source_type === 'automation_message' &&
      String(failureCode) === '131049'
    ) {
      try {
        await attemptAutomationMessageSmsFallback({ supabaseUrl, serviceKey, delivery });
      } catch (err) {
        console.warn('[whatsapp-webhook] automation_message SMS fallback threw', {
          deliveryId: delivery.id,
          error: err?.message ?? String(err),
        });
      }
    }

    // Phase 8.1 bug fix — a substitute-review decision (Reject Alternative /
    // Custom Instruction) completes on Meta's synchronous accept, but Meta
    // can still report a genuine async failure afterward (as it did here:
    // error 131049). `updated` is only true the first time this delivery
    // transitions to 'failed' (buildDeliveryStatusPatch treats 'failed' as
    // terminal and returns null on any later callback), so this reopen path
    // is naturally idempotent — no separate dedup key needed. Scoped to
    // exactly the deliveries linked to a completed rejected_alternative/
    // custom_instruction decision; every other WhatsApp failure (including
    // Approve Alternative, which never has a linked delivery) is untouched.
    if (updated && status === 'failed') {
      try {
        await reopenSubstituteReviewIfApplicable({ supabaseUrl, serviceKey, deliveryId: delivery.id });
      } catch (err) {
        console.warn('[whatsapp-webhook] substitute-review reopen threw (non-fatal)', {
          deliveryId: delivery.id,
          error: err?.message ?? String(err),
        });
      }
    }

    console.log('Canonical WhatsApp delivery status processed', {
      deliveryId: delivery.id,
      messageId,
      incomingStatus: status,
      previousStatus: delivery.delivery_status,
      updated,
    });

    return {
      matched: true,
      updated,
      deliveryId: delivery.id,
      messageId,
      status,
    };
  } catch (err) {
    return {
      matched: false,
      updated: false,
      error: 'unexpected_error',
      messageId,
      status,
      details: err?.message ?? String(err),
    };
  }
}

export function buildDeliveryStatusPatch({
  currentStatus,
  incomingStatus,
  updatedAt,
  currentLastStatusAt,
  failureReason,
  failureCode,
  failureSubcode,
}) {
  if (currentStatus === 'failed') return null;

  const eventAt = validIsoOrNow(updatedAt);
  const lastStatusAt = laterIso(currentLastStatusAt, eventAt);

  if (incomingStatus === 'failed') {
    return {
      delivery_status: 'failed',
      failed_at: eventAt,
      last_status_at: lastStatusAt,
      failure_stage: 'meta_api',
      failure_reason: failureReason || 'WhatsApp delivery failed.',
      failure_code: failureCode == null ? null : String(failureCode),
      failure_subcode: failureSubcode == null ? null : String(failureSubcode),
    };
  }

  const currentRank = DELIVERY_STATUS_RANK[currentStatus];
  const incomingRank = DELIVERY_STATUS_RANK[incomingStatus];
  if (currentRank == null || incomingRank == null) return null;

  // Ignore state regressions. A duplicate status only updates last_status_at
  // when this webhook carries a newer event timestamp.
  if (incomingRank < currentRank) {
    return lastStatusAt !== currentLastStatusAt
      ? { last_status_at: lastStatusAt }
      : null;
  }

  const patch = { last_status_at: lastStatusAt };
  if (incomingRank > currentRank) {
    patch.delivery_status = incomingStatus;
    if (incomingStatus === 'sent') patch.sent_at = eventAt;
    if (incomingStatus === 'delivered') patch.delivered_at = eventAt;
    if (incomingStatus === 'read') patch.read_at = eventAt;
  }
  return patch;
}

async function recordWebhookHeartbeat({
  supabaseUrl,
  serviceKey,
  phoneNumberIds,
  webhookReceivedAt,
  hasStatuses,
}) {
  const ids = phoneNumberIds.length > 0
    ? phoneNumberIds
    : [String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim()].filter(Boolean);

  for (const phoneNumberId of ids) {
    try {
      // Update any existing rows even when no delivery owner can be resolved
      // from this particular payload.
      await patchHealthRowsForPhoneNumber({
        supabaseUrl,
        serviceKey,
        phoneNumberId,
        fields: {
          last_webhook_received_at: webhookReceivedAt,
          ...(hasStatuses ? { last_status_webhook_at: webhookReceivedAt } : {}),
        },
      });

      const ownersRes = await fetch(
        `${supabaseUrl}/rest/v1/whatsapp_deliveries` +
          `?select=user_id` +
          `&order=created_at.desc` +
          `&limit=100`,
        { headers: serviceHeaders(serviceKey) },
      );
      if (!ownersRes.ok) continue;
      const rows = await ownersRes.json().catch(() => []);
      const userIds = [
        ...new Set(
          (Array.isArray(rows) ? rows : [])
            .map((row) => row.user_id)
            .filter(Boolean),
        ),
      ];
      for (const userId of userIds) {
        await upsertHealthState({
          supabaseUrl,
          serviceKey,
          userId,
          phoneNumberId,
          fields: {
            last_webhook_received_at: webhookReceivedAt,
            ...(hasStatuses ? { last_status_webhook_at: webhookReceivedAt } : {}),
          },
        });
      }
    } catch (err) {
      console.warn('WhatsApp webhook heartbeat update failed open', {
        phoneNumberId,
        error: err?.message ?? String(err),
      });
    }
  }
}

async function patchHealthRowsForPhoneNumber({
  supabaseUrl,
  serviceKey,
  phoneNumberId,
  fields,
}) {
  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/whatsapp_health_state` +
        `?phone_number_id=eq.${encodeURIComponent(phoneNumberId)}`,
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
      console.warn('WhatsApp health heartbeat patch failed open', {
        phoneNumberId,
        status: response.status,
        details,
      });
    }
  } catch (err) {
    console.warn('WhatsApp health heartbeat patch threw open', {
      phoneNumberId,
      error: err?.message ?? String(err),
    });
  }
}

async function updateMatchedHealthState({
  supabaseUrl,
  serviceKey,
  userId,
  phoneNumberId,
  webhookReceivedAt,
  status,
}) {
  const resolvedPhoneNumberId =
    String(phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  if (!userId || !resolvedPhoneNumberId) return;

  const fields = {
    last_webhook_received_at: webhookReceivedAt,
    last_status_webhook_at: webhookReceivedAt,
    last_matched_status_at: webhookReceivedAt,
  };
  if (status === 'delivered' || status === 'read') {
    fields.last_delivered_at = webhookReceivedAt;
  }
  if (status === 'failed') {
    fields.last_failed_at = webhookReceivedAt;
  }

  await upsertHealthState({
    supabaseUrl,
    serviceKey,
    userId,
    phoneNumberId: resolvedPhoneNumberId,
    fields,
  });
}

async function upsertHealthState({
  supabaseUrl,
  serviceKey,
  userId,
  phoneNumberId,
  fields,
}) {
  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/whatsapp_health_state` +
        `?on_conflict=user_id,phone_number_id`,
      {
        method: 'POST',
        headers: {
          ...serviceHeaders(serviceKey),
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          user_id: userId,
          phone_number_id: phoneNumberId,
          ...fields,
        }),
      },
    );
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      console.warn('WhatsApp health state update failed open', {
        userId,
        phoneNumberId,
        status: response.status,
        details,
      });
    }
  } catch (err) {
    console.warn('WhatsApp health state update threw open', {
      userId,
      phoneNumberId,
      error: err?.message ?? String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Payload extractors
// ---------------------------------------------------------------------------

function extractInboundMessages(body) {
  const entries  = Array.isArray(body?.entry) ? body.entry : [];
  const messages = [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value    = change?.value || {};
      const rawMsgs  = Array.isArray(value.messages) ? value.messages : [];
      for (const raw of rawMsgs) {
        const from      = String(raw?.from || '').trim();
        const messageId = String(raw?.id   || '').trim();
        const msgBody   = raw?.type === 'text' ? String(raw?.text?.body || '').trim() : '';
        if (!from || !messageId || !msgBody) continue;

        messages.push({
          from, messageId, body: msgBody, timestamp: raw?.timestamp,
          phoneNumberId: String(value?.metadata?.phone_number_id || '').trim(),
          contextMessageId: String(raw?.context?.id || '').trim() || null,
        });
      }
    }
  }

  return messages;
}

function extractStatuses(body) {
  const entries  = Array.isArray(body?.entry) ? body.entry : [];
  const statuses = [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value      = change?.value || {};
      const rawStatuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const raw of rawStatuses) {
        const messageId = String(raw?.id     || '').trim();
        const status    = String(raw?.status || '').trim();
        if (!messageId || !status) continue;

        const failureDetails = getFailureDetails(raw);
        statuses.push({
          messageId,
          status,
          updatedAt:      timestampToIso(raw?.timestamp),
          failureReason:  failureDetails.reason,
          failureCode:    failureDetails.code,
          failureSubcode: failureDetails.subcode,
          phoneNumberId: String(value?.metadata?.phone_number_id || '').trim() || null,
        });
      }
    }
  }

  return statuses;
}

function extractPhoneNumberIds(body) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  const ids = new Set();
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const id = String(change?.value?.metadata?.phone_number_id || '').trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function verifyWebhook(req, res) {
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const mode        = req.query?.['hub.mode'];
  const token       = req.query?.['hub.verify_token'];
  const challenge   = req.query?.['hub.challenge'];

  if (!verifyToken) {
    console.error('WhatsApp webhook verify token is not configured');
    return res.status(500).send('Webhook verify token is not configured.');
  }

  if (mode === 'subscribe' && token === verifyToken && challenge) {
    console.log('WhatsApp webhook verified');
    return res.status(200).send(String(challenge));
  }

  console.warn('WhatsApp webhook verification failed', { mode, hasToken: Boolean(token) });
  return res.status(403).send('Webhook verification failed.');
}

function timestampToIso(timestamp) {
  const seconds = Number(timestamp);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Extracts the human-readable reason AND the Meta error code/subcode from a
 * webhook status entry. Previously only the reason text was kept — the
 * numeric code/subcode (e.g. 131049 for ecosystem-engagement pacing) was
 * read off `first.code` as a last-resort *reason* string, then discarded.
 * whatsapp_deliveries already has failure_code/failure_subcode columns
 * (populated by the synchronous send path in _whatsapp-delivery.js); the
 * async webhook path never wrote them, so failures reported later via
 * webhook callback lost their machine-readable error code entirely.
 */
export function getFailureDetails(status) {
  const errors = Array.isArray(status?.errors) ? status.errors : [];
  const first  = errors[0];
  if (!first) return { reason: null, code: null, subcode: null };

  return {
    reason:
      first.error_data?.details ||
      first.message ||
      first.title ||
      first.code?.toString() ||
      'WhatsApp delivery failed.',
    code: first.code ?? null,
    subcode: first.error_subcode ?? null,
  };
}

/**
 * Recurring message automations have no task, no confirmation link, and
 * (by the plain-message boundary in send-whatsapp-task.js) no SMS fallback
 * on the synchronous send path. When Meta accepts the send and only later
 * reports `failed` via this webhook with error 131049 — a pacing/quality
 * throttle on the Marketing-category ra7etbal_routine_message template —
 * there was previously nothing left to try. This reuses the same Twilio
 * path send-whatsapp-task.js already uses for synchronous task-template
 * failures, scoped to this exact failure. No-ops (fail-open) unless
 * SMS_FALLBACK_ENABLED + Twilio env vars are configured.
 */
export async function attemptAutomationMessageSmsFallback({
  supabaseUrl,
  serviceKey,
  delivery,
}) {
  const smsFallbackEnabled = process.env.SMS_FALLBACK_ENABLED === 'true';
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFromNumber = process.env.TWILIO_FROM_NUMBER;
  const recipientPhone = delivery?.recipient_phone;

  if (!smsFallbackEnabled || !twilioAccountSid || !twilioAuthToken || !twilioFromNumber || !recipientPhone) {
    console.log('[whatsapp-webhook] automation_message SMS fallback skipped — not configured', {
      deliveryId: delivery?.id,
      smsFallbackEnabled,
      hasTwilioCreds: Boolean(twilioAccountSid && twilioAuthToken && twilioFromNumber),
      hasRecipientPhone: Boolean(recipientPhone),
    });
    return { attempted: false, reason: 'not_configured' };
  }

  const metadata = isPlainObject(delivery?.metadata) ? delivery.metadata : {};
  const messageText = typeof metadata.message_text === 'string' ? metadata.message_text.trim() : '';
  if (!messageText) {
    console.warn('[whatsapp-webhook] automation_message SMS fallback skipped — no stored message text', {
      deliveryId: delivery?.id,
    });
    return { attempted: false, reason: 'no_message_text' };
  }

  const body = buildSmsBody({ ownerName: null, messageText, confirmationLink: null });
  const smsResult = await sendTwilioSms({
    to: recipientPhone,
    body,
    accountSid: twilioAccountSid,
    authToken: twilioAuthToken,
    fromNumber: twilioFromNumber,
  });

  if (smsResult.ok) {
    console.log('[whatsapp-webhook] automation_message SMS fallback sent', {
      deliveryId: delivery.id,
      sid: smsResult.sid,
    });
  } else {
    console.error('[whatsapp-webhook] automation_message SMS fallback failed', {
      deliveryId: delivery?.id,
      error: smsResult.error,
    });
  }

  await recordSmsFallbackOutcome({
    supabaseUrl,
    serviceKey,
    deliveryId: delivery.id,
    existingMetadata: metadata,
    outcome: {
      attempted_at: new Date().toISOString(),
      sent: smsResult.ok,
      sid: smsResult.sid ?? null,
      error: smsResult.ok ? null : smsResult.error,
    },
  });

  return { attempted: true, sent: smsResult.ok };
}

/**
 * Reopens a substitute_review owner decision when the WhatsApp message it
 * sent (Reject Alternative or Custom Instruction) turns out to have failed
 * asynchronously, after the decision had already completed on Meta's
 * synchronous accept. No-ops for every unrelated delivery (ordinary
 * delegations/corrections/automations have no linked decision row at all;
 * Approve Alternative never has a delivery_id). See
 * supabase/migrations/20260711_reopen_substitute_on_async_delivery_failure.sql.
 */
async function reopenSubstituteReviewIfApplicable({ supabaseUrl, serviceKey, deliveryId }) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/reopen_substitute_decision_on_delivery_failure`,
    {
      method: 'POST',
      headers: { ...serviceHeaders(serviceKey) },
      body: JSON.stringify({ p_delivery_id: deliveryId }),
    },
  );
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    console.warn('[whatsapp-webhook] reopen_substitute_decision_on_delivery_failure RPC failed', {
      deliveryId,
      status: response.status,
      details,
    });
    return;
  }

  const rows = await response.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.reopened) return; // not applicable, or the task already moved on for an unrelated reason

  console.log('[whatsapp-webhook] substitute_review reopened after async delivery failure', {
    taskId: row.task_id,
  });

  await sendOwnerPush({
    supabaseUrl,
    serviceKey,
    userId: row.user_id,
    description: row.description,
    assignedTo: row.assigned_to,
    variant: 'substitute_delivery_failed',
  }).catch((err) =>
    console.warn('[whatsapp-webhook] substitute-review reopen owner push failed (non-fatal):', err?.message || err),
  );
}

async function recordSmsFallbackOutcome({ supabaseUrl, serviceKey, deliveryId, existingMetadata, outcome }) {
  try {
    await fetch(
      `${supabaseUrl}/rest/v1/whatsapp_deliveries?id=eq.${encodeURIComponent(deliveryId)}`,
      {
        method: 'PATCH',
        headers: { ...serviceHeaders(serviceKey), Prefer: 'return=minimal' },
        body: JSON.stringify({
          metadata: { ...existingMetadata, sms_fallback: outcome },
        }),
      },
    );
  } catch (err) {
    console.warn('[whatsapp-webhook] sms_fallback metadata patch threw (non-fatal)', {
      deliveryId,
      error: err?.message ?? String(err),
    });
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serviceHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

function validIsoOrNow(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function laterIso(left, right) {
  if (!left) return right;
  const leftMs = new Date(left).getTime();
  const rightMs = new Date(right).getTime();
  if (Number.isNaN(leftMs)) return right;
  if (Number.isNaN(rightMs)) return left;
  return rightMs > leftMs ? new Date(rightMs).toISOString() : new Date(leftMs).toISOString();
}
