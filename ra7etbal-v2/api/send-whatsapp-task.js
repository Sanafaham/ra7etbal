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

  // ── Template selection ────────────────────────────────────────────────────
  // Text tasks (no imagePath):
  //   PRIMARY:  ra7etbal_task_v3       (3 params: owner, message, link)
  //   FALLBACK: ra7etbal_task_assignment (2 params: message, link)
  //
  // Image tasks (imagePath present):
  //   PRIMARY:  ra7etbal_task_image    (image header + 3 body params: owner, message, link)
  //   FALLBACK: ra7etbal_task_assignment + separate image media message (legacy behavior)
  const primaryTemplateName = imagePath ? 'ra7etbal_task_image' : 'ra7etbal_task_v3';
  const fallbackTemplateName = 'ra7etbal_task_assignment';

  // ── Image upload for ra7etbal_task_image ──────────────────────────────────
  // For image tasks, attempt to upload the image to Meta and use it in the
  // image-header template. If upload fails, fall through to legacy behavior
  // (separate image media message + ra7etbal_task_assignment).
  let metaMediaId = null;     // set if Meta upload succeeds
  let imageSignedUrl = null;  // set if signed URL generation succeeds
  let imageSendStatus = 'skipped'; // skipped | uploaded | sent | failed | no_signed_url

  if (imagePath) {
    imageSignedUrl = await generateReferenceImageUrl({ supabaseUrl, serviceKey, imagePath });
    if (!imageSignedUrl) {
      imageSendStatus = 'no_signed_url';
      console.warn('[send-whatsapp-task] could not generate signed URL for image', {
        imagePathPresent: Boolean(imagePath),
      });
    } else {
      // Try uploading to Meta for the image-header template
      try {
        metaMediaId = await uploadImageToMeta({ accessToken, phoneNumberId, imageUrl: imageSignedUrl });
        if (metaMediaId) {
          imageSendStatus = 'uploaded';
          console.log('[send-whatsapp-task] image uploaded to Meta', { metaMediaId });
        } else {
          console.warn('[send-whatsapp-task] Meta image upload returned no media_id — will use legacy fallback');
        }
      } catch (err) {
        console.warn('[send-whatsapp-task] Meta image upload threw — will use legacy fallback', {
          message: err?.message ?? String(err),
        });
      }
    }
  }

  // If image upload failed, revert to legacy path:
  // send as separate media message + ra7etbal_task_assignment
  const useImageTemplate = imagePath && metaMediaId !== null;
  const effectivePrimaryTemplate = useImageTemplate ? primaryTemplateName : (imagePath ? 'ra7etbal_task_assignment' : primaryTemplateName);

  // ── Legacy: separate image media message ─────────────────────────────────
  // Used when imagePath is set but Meta upload failed (graceful degradation).
  // Send image as a separate media message BEFORE the template.
  if (imagePath && !metaMediaId) {
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
        if (imageResult.ok) {
          imageSendStatus = 'sent';
        } else {
          imageSendStatus = 'failed';
          console.warn('[send-whatsapp-task] legacy image send failed (non-fatal), adding fallback link', {
            status: imageResult.status,
            errorCode: imageResult.metaError?.code ?? null,
            errorSubcode: imageResult.metaError?.error_subcode ?? null,
            errorMessage: typeof imageResult.metaError?.message === 'string'
              ? imageResult.metaError.message
              : null,
          });
          cleanMessage = `${cleanMessage}\n\nReference photo:\n${imageSignedUrl}`;
        }
      } catch (err) {
        imageSendStatus = 'failed';
        console.warn('[send-whatsapp-task] legacy image send threw (non-fatal), adding fallback link', {
          message: err?.message ?? String(err),
        });
        cleanMessage = `${cleanMessage}\n\nReference photo:\n${imageSignedUrl}`;
      }
    }
  }

  /**
   * Build the template payload for a given template name.
   *
   * ra7etbal_task_v3 / ra7etbal_task_v2:
   *   body: {{1}} owner, {{2}} message, {{3}} link  (3 params)
   *
   * ra7etbal_task_image:
   *   header: image (via Meta media_id)
   *   body:   {{1}} owner, {{2}} message, {{3}} link  (3 params — same as v3)
   *
   * ra7etbal_task_assignment:
   *   body: {{1}} message, {{2}} link  (2 params)
   */
  function buildTemplatePayload(tplName, mediaId = null) {
    const isImageTemplate = tplName === 'ra7etbal_task_image';
    const is3Param =
      tplName === 'ra7etbal_task_v3' ||
      tplName === 'ra7etbal_task_v2' ||
      isImageTemplate;

    const components = [];

    // Header component — only for ra7etbal_task_image when we have a media_id
    if (isImageTemplate && mediaId) {
      components.push({
        type: 'header',
        parameters: [{ type: 'image', image: { id: mediaId } }],
      });
    }

    // Body component
    components.push({
      type: 'body',
      parameters: is3Param
        ? [
            { type: 'text', text: cleanOwnerName }, // {{1}} — owner name
            { type: 'text', text: cleanMessage },   // {{2}} — task text
            { type: 'text', text: cleanLink },      // {{3}} — confirmation link
          ]
        : [
            { type: 'text', text: cleanMessage },   // {{1}} — task text
            { type: 'text', text: cleanLink },      // {{2}} — confirmation link
          ],
    });

    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'template',
      template: {
        name: tplName,
        language: { code: templateLanguage },
        components,
      },
    };
  }

  try {
    // ── Primary send ─────────────────────────────────────────────────────────
    const primaryPayload = buildTemplatePayload(effectivePrimaryTemplate, metaMediaId);

    console.log('WhatsApp template send attempt', {
      phoneNumberIdLast4,
      to: normalizedTo,
      tokenConfigured: Boolean(accessToken),
      taskId: taskId || null,
      messageRecordId: messageRecordId || null,
      recipientName: recipientName || null,
      ownerName: cleanOwnerName,
      imagePathPresent: Boolean(imagePath),
      metaMediaId: metaMediaId || null,
      imageSendStatus,
      mode: 'template',
      templateName: effectivePrimaryTemplate,
      templateLanguage,
      payload: redactPayloadForLog(primaryPayload),
    });

    let templateResult = await sendMetaMessage({ url, accessToken, payload: primaryPayload });
    let usedTemplateName = effectivePrimaryTemplate;

    // ── Fallback send ─────────────────────────────────────────────────────────
    // If Meta rejects the primary template, retry once with ra7etbal_task_assignment.
    // For image tasks where the image template failed but we already sent a
    // separate media message (legacy path), ra7etbal_task_assignment still works.
    if (!templateResult.ok) {
      const metaCode = templateResult.metaError?.code;
      const isTemplateError =
        metaCode === 132001 || // template not found
        metaCode === 132000 || // template does not exist
        metaCode === 100;      // generic parameter / template issue

      if (isTemplateError || templateResult.status === 400) {
        console.warn('WhatsApp primary template failed — retrying with fallback', {
          primaryTemplate: effectivePrimaryTemplate,
          fallbackTemplate: fallbackTemplateName,
          metaCode,
          status: templateResult.status,
        });

        const fallbackPayload = buildTemplatePayload(fallbackTemplateName);
        templateResult = await sendMetaMessage({ url, accessToken, payload: fallbackPayload });
        usedTemplateName = fallbackTemplateName;

        console.log('WhatsApp fallback template send attempt', {
          templateName: fallbackTemplateName,
          ok: templateResult.ok,
          status: templateResult.status,
        });
      }
    }

    if (!templateResult.ok) {
      console.error('WhatsApp template send failed', {
        status: templateResult.status,
        metaError: templateResult.metaError,
        usedTemplateName,
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
      templateName: usedTemplateName,
      templateLanguage,
      imageSendStatus,
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
/**
 * Upload an image to the Meta media endpoint for use in image-header templates.
 *
 * Steps:
 *   1. Download image from the signed Supabase URL.
 *   2. POST as multipart/form-data to /{phoneNumberId}/media.
 *   3. Return the Meta media_id string, or null on any failure.
 *
 * The media_id is passed into the template header component so Meta serves
 * the image directly — no separate image message needed.
 */
async function uploadImageToMeta({ accessToken, phoneNumberId, imageUrl }) {
  if (!accessToken || !phoneNumberId || !imageUrl) return null;

  try {
    // Download image from Supabase signed URL
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      console.warn('[send-whatsapp-task] uploadImageToMeta: image download failed', {
        status: imageResponse.status,
      });
      return null;
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = await imageResponse.arrayBuffer();

    // Build multipart form — Meta requires messaging_product, type, and file
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', contentType);
    formData.append(
      'file',
      new Blob([imageBuffer], { type: contentType }),
      'task-image.jpg',
    );

    const uploadUrl = `https://graph.facebook.com/v20.0/${phoneNumberId}/media`;
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    });

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text().catch(() => '');
      console.warn('[send-whatsapp-task] uploadImageToMeta: Meta upload failed', {
        status: uploadResponse.status,
        body: errText.slice(0, 300),
      });
      return null;
    }

    const data = await uploadResponse.json();
    return data?.id || null;
  } catch (err) {
    console.warn('[send-whatsapp-task] uploadImageToMeta threw', {
      message: err?.message ?? String(err),
    });
    return null;
  }
}

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
