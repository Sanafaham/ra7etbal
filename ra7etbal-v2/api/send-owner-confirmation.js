const GRAPH_VERSION = 'v20.0';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed',
      details: 'Use POST to send an owner confirmation message.',
      status: 405,
    });
  }

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const ownerWhatsAppNumber = process.env.OWNER_WHATSAPP_NUMBER;
  const phoneNumberIdLast4 = phoneNumberId ? String(phoneNumberId).slice(-4) : null;
  const ownerNumberLast4 = ownerWhatsAppNumber
    ? String(normalizePhone(ownerWhatsAppNumber)).slice(-4)
    : null;

  if (!accessToken || !phoneNumberId || !ownerWhatsAppNumber) {
    console.error('OWNER_CONFIRMATION_FAILED', {
      reason: 'missing_configuration',
      tokenConfigured: Boolean(accessToken),
      phoneNumberIdLast4,
      ownerNumberConfigured: Boolean(ownerWhatsAppNumber),
    });
    return res.status(500).json({
      success: false,
      error: 'Owner WhatsApp is not configured.',
      details:
        'Missing WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, or OWNER_WHATSAPP_NUMBER.',
      status: 500,
    });
  }

  const { taskText, personName, taskId } = req.body || {};
  const body = buildMessageBody({ taskText, personName });
  if (!body) {
    console.error('OWNER_CONFIRMATION_FAILED', {
      reason: 'missing_task_text',
      taskId: taskId || null,
      phoneNumberIdLast4,
      ownerNumberLast4,
    });
    return res.status(400).json({
      success: false,
      error: 'Task text is required.',
      details: 'The frontend sent an empty taskText value.',
      status: 400,
    });
  }

  const to = normalizePhone(ownerWhatsAppNumber);
  if (!to) {
    console.error('OWNER_CONFIRMATION_FAILED', {
      reason: 'invalid_owner_number',
      taskId: taskId || null,
      phoneNumberIdLast4,
      ownerNumberConfigured: Boolean(ownerWhatsAppNumber),
    });
    return res.status(500).json({
      success: false,
      error: 'Owner WhatsApp number is invalid.',
      details: 'OWNER_WHATSAPP_NUMBER must contain a valid WhatsApp phone number.',
      status: 500,
    });
  }

  try {
    console.log('OWNER_CONFIRMATION_ATTEMPT', {
      taskId: taskId || null,
      personName: personName || null,
      tokenConfigured: Boolean(accessToken),
      phoneNumberIdLast4,
      ownerNumberLast4: String(to).slice(-4),
    });

    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: {
            preview_url: false,
            body,
          },
        }),
      },
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const metaMessage =
        data?.error?.error_data?.details ||
        data?.error?.message ||
        'Owner WhatsApp notification failed.';
      console.error('OWNER_CONFIRMATION_FAILED', {
        taskId: taskId || null,
        status: response.status,
        metaError: data?.error || metaMessage,
        phoneNumberIdLast4,
        ownerNumberLast4: String(to).slice(-4),
      });
      return res.status(response.status).json({
        success: false,
        error: 'Owner WhatsApp notification failed.',
        details: metaMessage,
        status: response.status,
        taskId: taskId || null,
      });
    }

    const messageId = data?.messages?.[0]?.id || null;
    const acceptedAt = new Date().toISOString();

    console.log('OWNER_CONFIRMATION_SUCCESS', {
      messageId,
      ownerNumberLast4: String(to).slice(-4),
      phoneNumberIdLast4,
      acceptedAt,
      taskId: taskId || null,
    });

    return res.status(200).json({
      success: true,
      provider: 'whatsapp_cloud_api',
      messageId,
      acceptedAt,
      phoneNumberIdLast4,
      taskId: taskId || null,
    });
  } catch (err) {
    console.error('OWNER_CONFIRMATION_FAILED', {
      taskId: taskId || null,
      error: err instanceof Error ? err.message : 'Unexpected server error.',
      phoneNumberIdLast4,
      ownerNumberLast4: String(to).slice(-4),
    });
    return res.status(500).json({
      success: false,
      error: 'Could not notify owner on WhatsApp.',
      details: err instanceof Error ? err.message : 'Unexpected server error.',
      status: 500,
    });
  }
}

function buildMessageBody({ taskText, personName }) {
  const task = String(taskText || '').trim();
  if (!task) return '';
  const person = String(personName || '').trim() || 'Someone';
  return `${person} marked this done:\n${task}`;
}

function normalizePhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  let digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return digits;
}
