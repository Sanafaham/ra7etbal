const ALLOWED_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return verifyWebhook(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const statuses = extractStatuses(req.body);
  console.log('WhatsApp webhook POST received', {
    entries: Array.isArray(req.body?.entry) ? req.body.entry.length : 0,
    statuses: statuses.map((item) => ({
      messageId: item.messageId,
      status: item.status,
      updatedAt: item.updatedAt,
      hasFailureReason: Boolean(item.failureReason),
    })),
  });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error('WhatsApp webhook storage is not configured');
    return res.status(200).json({
      success: false,
      processed: statuses.length,
      error: 'Webhook storage is not configured.',
    });
  }

  if (statuses.length === 0) {
    console.log('WhatsApp webhook received no status updates');
    return res.status(200).json({ success: true, processed: 0 });
  }

  const results = [];
  for (const item of statuses) {
    if (!ALLOWED_STATUSES.has(item.status)) {
      console.log('WhatsApp webhook ignored status', {
        messageId: item.messageId,
        status: item.status,
      });
      continue;
    }

    const result = await updateMessageStatus({
      supabaseUrl,
      serviceKey,
      messageId: item.messageId,
      status: item.status,
      updatedAt: item.updatedAt,
      failureReason: item.failureReason,
    });
    results.push(result);
  }

  const failed = results.filter((r) => !r.updated);
  if (failed.length > 0) {
    console.warn('WhatsApp webhook status update warnings', { failed });
  }

  return res.status(200).json({
    success: true,
    processed: results.length,
    updated: results.filter((r) => r.updated).length,
    failed: failed.length,
  });
}

function verifyWebhook(req, res) {
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const mode = req.query?.['hub.mode'];
  const token = req.query?.['hub.verify_token'];
  const challenge = req.query?.['hub.challenge'];

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

function extractStatuses(body) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  const statuses = [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      const rawStatuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const raw of rawStatuses) {
        const messageId = String(raw?.id || '').trim();
        const status = String(raw?.status || '').trim();
        if (!messageId || !status) continue;

        statuses.push({
          messageId,
          status,
          updatedAt: timestampToIso(raw?.timestamp),
          failureReason: getFailureReason(raw),
        });
      }
    }
  }

  return statuses;
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
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        whatsapp_delivery_status: status,
        whatsapp_status_updated_at: updatedAt,
        whatsapp_failure_reason: status === 'failed' ? failureReason : null,
      }),
    },
  );

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    return {
      updated: false,
      messageId,
      status,
      httpStatus: response.status,
      details,
    };
  }

  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      updated: false,
      messageId,
      status,
      details: 'No message matched this WhatsApp message id.',
    };
  }

  console.log('WhatsApp delivery status updated', {
    messageId,
    status,
    updatedAt,
    hasFailureReason: Boolean(failureReason),
  });

  return { updated: true, messageId, status, appMessageId: rows[0]?.id || null };
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
  const first = errors[0];
  if (!first) return null;

  return (
    first.error_data?.details ||
    first.message ||
    first.title ||
    first.code?.toString() ||
    'WhatsApp delivery failed.'
  );
}
