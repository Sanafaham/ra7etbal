const ALLOWED_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

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

  // --- Process delivery status updates ---
  const statusResults = [];
  for (const item of statuses) {
    if (!ALLOWED_STATUSES.has(item.status)) {
      console.log('WhatsApp webhook ignored status', { messageId: item.messageId, status: item.status });
      continue;
    }
    const result = await updateMessageStatus({ supabaseUrl, serviceKey, ...item });
    statusResults.push(result);
  }

  const failedStatuses = statusResults.filter((r) => !r.updated);
  if (failedStatuses.length > 0) {
    console.warn('WhatsApp webhook status update warnings', { failed: failedStatuses });
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
    `${supabaseUrl}/rest/v1/people?select=id,user_id,name,phone&whatsapp_opted_in=neq.null`,
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
        });
      }
    }
  }

  return statuses;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function verifyWebhook(req, res) {
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const mode        = req.query?.['hub.mode'];
  const token       = req.query?.['hub.verify_token'];
  const challenge   = req.query?.['hub.challenge'];

  // Temporary diagnostic — lengths only, no secret values
  console.log('WhatsApp webhook verify diagnostic', {
    envTokenExists:    Boolean(verifyToken),
    envTokenLength:    verifyToken ? verifyToken.length : 0,
    incomingTokenLength: token ? token.length : 0,
    tokensMatch:       token === verifyToken,
    modeIsSubscribe:   mode === 'subscribe',
    challengeExists:   Boolean(challenge),
  });

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
