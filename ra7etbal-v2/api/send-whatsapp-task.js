const TEMPLATE_NAME = 'ra7etbal_task_assignment';
const DEFAULT_TEMPLATE_LANGUAGE = 'en';
const FALLBACK_OWNER_NAME = 'Rahet Bal';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const templateLanguage =
    process.env.WHATSAPP_TEMPLATE_LANGUAGE || DEFAULT_TEMPLATE_LANGUAGE;

  const {
    to,
    messageText,
    confirmationLink,
    messageRecordId,
    taskId,
    recipientName,
    ownerName,
    imagePath,
  } = req.body || {};

  const normalizedTo = normalizeWhatsAppPhone(to);
  let cleanMessage = String(messageText || '').trim();
  const cleanLink = String(confirmationLink || '').trim();
  const cleanOwnerName = String(ownerName || '').trim() || FALLBACK_OWNER_NAME;
  const phoneNumberIdLast4 = phoneNumberId ? phoneNumberId.slice(-4) : null;

  if (!accessToken || !phoneNumberId) {
    return res.status(500).json({
      success: false,
      error: 'WhatsApp is not configured.',
      errorMessage: 'WhatsApp is not configured.',
      details: 'Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.',
    });
  }

  if (!normalizedTo) {
    return res.status(400).json({
      success: false,
      error: 'Recipient phone number is missing.',
      errorMessage: 'Recipient phone number is missing.',
      details: 'Add a WhatsApp phone number for this person, then retry.',
    });
  }

  if (!cleanMessage) {
    return res.status(400).json({
      success: false,
      error: 'Message text is missing.',
      errorMessage: 'Message text is missing.',
      details: 'Could not send an empty WhatsApp message.',
    });
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  if (!cleanLink) {
    return res.status(400).json({
      success: false,
      error: 'Confirmation link is missing.',
      errorMessage: 'Confirmation link is missing.',
      details: 'WhatsApp task templates require a confirmation link.',
    });
  }

  // ── Reference image send ──────────────────────────────────────────────────
  // If a Reference image is attached, send it as a WhatsApp image media message
  // BEFORE the template so the recipient sees the actual photo inline — not a link.
  // This is fire-and-continue: image failure is non-fatal.
  // Fallback: if the image media send fails, append the signed URL to the task
  // text so the link at least appears in the template body.
  if (imagePath && supabaseUrl && serviceKey && normalizedTo) {
    const imageSignedUrl = await generateReferenceImageUrl({ supabaseUrl, serviceKey, imagePath });
    if (imageSignedUrl) {
      const imagePayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizedTo,
        type: 'image',
        image: { link: imageSignedUrl },
      };
      try {
        const imageResult = await sendMetaMessage({ url, accessToken, payload: imagePayload });
        if (!imageResult.ok) {
          console.warn('[send-whatsapp-task] Reference image send failed (non-fatal), using text fallback', {
            status: imageResult.status,
            metaError: imageResult.metaError,
          });
          // Fallback: include URL in the template body text
          cleanMessage = `${cleanMessage}\n\nReference photo:\n${imageSignedUrl}`;
        }
      } catch (err) {
        console.warn('[send-whatsapp-task] Reference image send threw (non-fatal), using text fallback', err?.message);
        cleanMessage = `${cleanMessage}\n\nReference photo:\n${imageSignedUrl}`;
      }
    }
  }

  const templatePayload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedTo,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: templateLanguage },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: cleanMessage },   // {{1}} — task text
            { type: 'text', text: cleanLink },       // {{2}} — confirmation link
          ],
        },
      ],
    },
  };

  try {
    console.log('WhatsApp template send attempt', {
      phoneNumberIdLast4,
      to: normalizedTo,
      tokenConfigured: Boolean(accessToken),
      taskId: taskId || null,
      messageRecordId: messageRecordId || null,
      recipientName: recipientName || null,
      ownerName: cleanOwnerName,
      mode: 'template',
      templateName: TEMPLATE_NAME,
      templateLanguage,
      payload: redactPayloadForLog(templatePayload),
    });

    const templateResult = await sendMetaMessage({
      url,
      accessToken,
      payload: templatePayload,
    });

    if (!templateResult.ok) {
      console.error('WhatsApp template send failed', {
        status: templateResult.status,
        metaError: templateResult.metaError,
      });
      return sendFailure(res, templateResult);
    }

    await markMessageAccepted({
      supabaseUrl,
      serviceKey,
      messageRecordId,
      messageId: templateResult.messageId,
    });

    return res.status(200).json({
      success: true,
      sendMode: 'template',
      sendType: 'template',
      messageId: templateResult.messageId,
      to: normalizedTo,
      acceptedAt: new Date().toISOString(),
      phoneNumberIdLast4,
      templateName: TEMPLATE_NAME,
      templateLanguage,
    });
  } catch (err) {
    console.error('WhatsApp task send route failed', {
      message: err instanceof Error ? err.message : String(err),
      to: normalizedTo,
      phoneNumberIdLast4,
    });
    return res.status(500).json({
      success: false,
      error: 'Could not send WhatsApp message.',
      errorMessage: 'Could not send WhatsApp message.',
      details: err instanceof Error ? err.message : 'Unexpected server error.',
    });
  }
}

async function sendMetaMessage({ url, accessToken, payload }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const metaResponse = await readMetaResponse(response);
  const messageId = Array.isArray(metaResponse?.messages)
    ? metaResponse.messages[0]?.id || null
    : null;

  if (response.ok) {
    console.log('WhatsApp Cloud accepted message', {
      to: payload.to,
      messageId,
      type: payload.type,
      acceptedAt: new Date().toISOString(),
    });
  }

  return {
    ok: response.ok,
    status: response.status,
    metaResponse,
    metaError: metaResponse?.error || metaResponse,
    messageId,
  };
}

async function readMetaResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function sendFailure(res, result, freeFormError = null) {
  const errorMessage = safeMetaMessage(result.metaError);
  return res.status(result.status || 502).json({
    success: false,
    status: result.status || 502,
    error: 'Could not send WhatsApp message.',
    errorMessage,
    metaError: result.metaError,
    details: errorMessage,
    freeFormError,
  });
}

function normalizeWhatsAppPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return null;

  let digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return digits.length >= 7 ? digits : null;
}

function safeMetaMessage(metaError) {
  if (!metaError) return 'Could not send WhatsApp message.';
  if (typeof metaError === 'string') return metaError;
  if (typeof metaError.message === 'string' && metaError.message.trim()) {
    const details =
      typeof metaError.error_data?.details === 'string'
        ? metaError.error_data.details
        : '';
    return details ? `${metaError.message}: ${details}` : metaError.message;
  }
  if (typeof metaError.raw === 'string') return metaError.raw;
  return 'Could not send WhatsApp message.';
}

function redactPayloadForLog(payload) {
  return {
    ...payload,
    text: payload.text
      ? {
          ...payload.text,
          body: summarizeText(payload.text.body),
        }
      : undefined,
    template: payload.template
      ? {
          ...payload.template,
          components: payload.template.components?.map((component) => ({
            ...component,
            parameters: component.parameters?.map((param) => ({
              ...param,
              text: summarizeText(param.text),
            })),
          })),
        }
      : undefined,
  };
}

function summarizeText(value) {
  const text = String(value || '');
  return {
    present: text.length > 0,
    length: text.length,
  };
}

async function markMessageAccepted({
  supabaseUrl,
  serviceKey,
  messageRecordId,
  messageId,
}) {
  if (!supabaseUrl || !serviceKey || !messageRecordId || !messageId) return;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/messages?id=eq.${encodeURIComponent(messageRecordId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        whatsapp_message_id: messageId,
        whatsapp_delivery_status: 'sent',
        whatsapp_status_updated_at: new Date().toISOString(),
        whatsapp_failure_reason: null,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.warn('Could not update WhatsApp message status', {
      messageRecordId,
      messageId,
      status: response.status,
      body,
    });
  }
}

/**
 * Generate a 1-hour signed read URL for a Reference image so the recipient
 * can view it as a clickable link in WhatsApp before acting on the task.
 *
 * Uses the service role key — safe for server-side use only.
 * Returns null on any error so the WhatsApp send degrades gracefully
 * (message still sent, just without the image URL).
 */
async function generateReferenceImageUrl({ supabaseUrl, serviceKey, imagePath }) {
  if (!imagePath || !supabaseUrl || !serviceKey) return null;

  const BUCKET = 'task-images';
  const objectPath = imagePath.startsWith(`${BUCKET}/`)
    ? imagePath.slice(`${BUCKET}/`.length)
    : imagePath;

  try {
    const response = await fetch(
      `${supabaseUrl}/storage/v1/object/sign/${BUCKET}/${objectPath}`,
      {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.signedURL) return null;
    return `${supabaseUrl}/storage/v1${data.signedURL}`;
  } catch {
    return null;
  }
}
