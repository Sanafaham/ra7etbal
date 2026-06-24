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

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const statuses        = extractStatuses(req.body);
  const inboundMessages = extractInboundMessages(req.body);
  const phoneNumberIds  = extractPhoneNumberIds(req.body);
  const webhookReceivedAt = new Date().toISOString();

  console.log('WhatsApp webhook POST received', {
    entries:         Array.isArray(req.body?.entry) ? req.body.entry.length : 0,
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

  // --- Process inbound messages (consent replies) ---
  const consentResults = [];
  for (const msg of inboundMessages) {
    const result = await handleInboundConsentReply({ supabaseUrl, serviceKey, msg });
    consentResults.push(result);
  }

  return res.status(200).json({
    success:         true,
    statusProcessed: statusResults.length,
    statusUpdated:   statusResults.filter((r) => r.updated).length,
    deliveryMatched: deliveryResults.filter((r) => r.matched).length,
    deliveryUpdated: deliveryResults.filter((r) => r.updated).length,
    consentHandled:  consentResults.filter((r) => r.handled).length,
  });
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

async function findPersonByPhone({ supabaseUrl, serviceKey, rawPhone }) {
  // rawPhone from Meta is digits only without leading +.
  // people.phone may be stored as "+971501234567", "00971...", or "0501234567".
  // We strip all non-digits and use a LIKE suffix match on the last 9 digits,
  // which avoids false matches while handling country-code variations.
  const digits = String(rawPhone).replace(/\D/g, '');
  if (digits.length < 7) return null;

  const suffix = digits.slice(-9); // last 9 digits are unique enough

  const response = await fetch(
    `${supabaseUrl}/rest/v1/people?select=id,user_id,name,phone`,
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
  phoneNumberId,
  webhookReceivedAt = new Date().toISOString(),
  retryCount = 0,
}) {
  try {
    const lookupRes = await fetch(
      `${supabaseUrl}/rest/v1/whatsapp_deliveries` +
        `?meta_message_id=eq.${encodeURIComponent(messageId)}` +
        `&select=id,user_id,delivery_status,last_status_at,automation_run_id,source_type` +
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

        messages.push({ from, messageId, body: msgBody, timestamp: raw?.timestamp });
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

        statuses.push({
          messageId,
          status,
          updatedAt:     timestampToIso(raw?.timestamp),
          failureReason: getFailureReason(raw),
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

function getFailureReason(status) {
  const errors = Array.isArray(status?.errors) ? status.errors : [];
  const first  = errors[0];
  if (!first) return null;

  return (
    first.error_data?.details ||
    first.message ||
    first.title ||
    first.code?.toString() ||
    'WhatsApp delivery failed.'
  );
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
