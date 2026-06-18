const DEFAULT_TEMPLATE_LANGUAGE = 'en';
const FALLBACK_OWNER_NAME = 'Rahet Bal';
const TEMPLATE_SPECS = {
  ra7etbal_task_v3: {
    bodyParams: ['owner', 'message'],
    legacyBodyParams: ['owner', 'message', 'link'],
    buttonParam: 'link',
  },
  ra7etbal_task_image: {
    header: 'image',
    bodyParams: ['message'],
    legacyBodyParams: ['message', 'link'],
    buttonParam: 'link',
  },
  ra7etbal_task_assignment: {
    bodyParams: ['message'],
    legacyBodyParams: ['message', 'link'],
    buttonParam: 'link',
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Task templates are approved in 'en' — independent of the global
  // WHATSAPP_TEMPLATE_LANGUAGE env var (which is en_US for routine messages).
  const templateLanguage = DEFAULT_TEMPLATE_LANGUAGE;

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
  //   PRIMARY:  ra7etbal_task_v3    (3 params: owner, message, link)
  //   FALLBACK: ra7etbal_task_v3    (same template, different link placement variants)
  //
  // Image tasks (imagePath present):
  //   PRIMARY:  ra7etbal_task_image (image header + 3 body params: owner, message, link)
  //   FALLBACK: ra7etbal_task_v3   + separate image media message (if Meta upload fails)
  const primaryTemplateName = imagePath ? 'ra7etbal_task_image' : 'ra7etbal_task_v3';
  const fallbackTemplateName = 'ra7etbal_task_v3';

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
  // send as separate media message + ra7etbal_task_v3
  const useImageTemplate = imagePath && metaMediaId !== null;
  const effectivePrimaryTemplate = useImageTemplate ? primaryTemplateName : (imagePath ? 'ra7etbal_task_v3' : primaryTemplateName);

  console.log('[send-whatsapp-task] route config', {
    accessTokenConfigured: Boolean(accessToken),
    phoneNumberIdConfigured: Boolean(phoneNumberId),
    phoneNumberIdLast4,
    supabaseConfigured: Boolean(supabaseUrl && serviceKey),
    templateLanguage,
  });

  console.log('[send-whatsapp-task] template selected', {
    templateType: imagePath ? 'image' : 'text',
    primaryTemplate: primaryTemplateName,
    effectivePrimaryTemplate,
    fallbackTemplate: fallbackTemplateName,
    useImageTemplate,
    imageSendStatus,
    ownerName: cleanOwnerName,
  });

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
   * ra7etbal_task_v3 (PRIMARY — text tasks):
   *   body:   {{1}} owner, {{2}} message
   *   button: confirmation link suffix
   *
   * ra7etbal_task_image (PRIMARY — image tasks):
   *   header: image (via Meta media_id)
   *   body:   {{1}} message
   *   button: confirmation link suffix
   *
   * ra7etbal_task_assignment (FALLBACK):
   *   body:   {{1}} message
   *   button: confirmation link suffix
   */
  function buildTemplatePayload(
    tplName,
    mediaId = null,
    linkPlacement = 'button',
    buttonValueMode = 'full',
  ) {
    const spec = TEMPLATE_SPECS[tplName] || TEMPLATE_SPECS.ra7etbal_task_v3;
    const isImageTemplate = tplName === 'ra7etbal_task_image';
    const bodyParamNames =
      linkPlacement === 'body'
        ? (spec.legacyBodyParams || spec.bodyParams)
        : spec.bodyParams;

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
      parameters: bodyParamNames.map((paramName) => ({
        type: 'text',
        text: paramName === 'owner'
          ? cleanOwnerName
          : paramName === 'link'
          ? cleanLink
          : cleanMessage,
      })),
    });

    // Dynamic URL button component. Meta expects only the variable suffix
    // when the approved template button has a fixed URL prefix.
    if (linkPlacement === 'button' && spec.buttonParam === 'link') {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: buildButtonLinkValue(cleanLink, buttonValueMode) }],
      });
    }

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
    const attempts = [
      { label: 'primary-button-full', templateName: effectivePrimaryTemplate, isFallback: false, linkPlacement: 'button', buttonValueMode: 'full', mediaId: metaMediaId },
      { label: 'primary-button-path', templateName: effectivePrimaryTemplate, isFallback: false, linkPlacement: 'button', buttonValueMode: 'path', mediaId: metaMediaId },
      { label: 'primary-button-task', templateName: effectivePrimaryTemplate, isFallback: false, linkPlacement: 'button', buttonValueMode: 'task', mediaId: metaMediaId },
      { label: 'primary-body-link', templateName: effectivePrimaryTemplate, isFallback: false, linkPlacement: 'body', mediaId: metaMediaId },
      { label: 'fallback-button-full', templateName: fallbackTemplateName, isFallback: true, linkPlacement: 'button', buttonValueMode: 'full', mediaId: null },
      { label: 'fallback-button-path', templateName: fallbackTemplateName, isFallback: true, linkPlacement: 'button', buttonValueMode: 'path', mediaId: null },
      { label: 'fallback-button-task', templateName: fallbackTemplateName, isFallback: true, linkPlacement: 'button', buttonValueMode: 'task', mediaId: null },
      { label: 'fallback-body-link', templateName: fallbackTemplateName, isFallback: true, linkPlacement: 'body', mediaId: null },
    ];

    let templateResult = null;
    let usedTemplateName = effectivePrimaryTemplate;
    let usedAttempt = null;

    for (const attempt of attempts) {
      const payload = buildTemplatePayload(
        attempt.templateName,
        attempt.mediaId,
        attempt.linkPlacement,
        attempt.buttonValueMode || 'full',
      );

      logSendAttempt(attempt.label, {
          phoneNumberIdLast4,
          taskId,
          messageRecordId,
          recipientName,
          ownerName: cleanOwnerName,
          imagePathPresent: Boolean(imagePath),
          metaMediaId: attempt.mediaId,
          imageSendStatus,
          templateName: attempt.templateName,
          templateType: imagePath && attempt.templateName === 'ra7etbal_task_image' ? 'image' : 'text',
          isFallback: attempt.isFallback,
          linkPlacement: attempt.linkPlacement,
          buttonValueMode: attempt.buttonValueMode || null,
          templateLanguage,
          payload,
        });

      templateResult = await sendMetaMessage({ url, accessToken, payload });
      usedTemplateName = attempt.templateName;
      usedAttempt = attempt;

      console.log('[send-whatsapp-task] send attempt result', {
          attempt: attempt.label,
          templateName: attempt.templateName,
          isFallback: attempt.isFallback,
          linkPlacement: attempt.linkPlacement,
          buttonValueMode: attempt.buttonValueMode || null,
          ok: templateResult.ok,
          status: templateResult.status,
        });

      if (templateResult.ok) break;

      console.warn('[send-whatsapp-task] template attempt failed — trying next template shape', {
        attempt: attempt.label,
        templateName: attempt.templateName,
        linkPlacement: attempt.linkPlacement,
        buttonValueMode: attempt.buttonValueMode || null,
        status: templateResult.status,
        metaError: templateResult.metaError,
      });
      }

    if (!templateResult?.ok) {
      console.error('[send-whatsapp-task] template send failed', {
        status: templateResult?.status ?? null,
        metaError: templateResult?.metaError ?? null,
        usedTemplateName,
        usedAttempt,
      });
      return sendFailure(res, templateResult);
    }

    console.log('[send-whatsapp-task] send accepted', {
      templateName: usedTemplateName,
      isFallback: usedTemplateName === fallbackTemplateName,
      attempt: usedAttempt?.label ?? null,
      linkPlacement: usedAttempt?.linkPlacement ?? null,
      buttonValueMode: usedAttempt?.buttonValueMode ?? null,
      templateType: imagePath ? 'image' : 'text',
      ownerName: cleanOwnerName,
      messageId: templateResult.messageId,
    });

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
      attempt: usedAttempt?.label ?? null,
      linkPlacement: usedAttempt?.linkPlacement ?? null,
      buttonValueMode: usedAttempt?.buttonValueMode ?? null,
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
  console.log('[send-whatsapp-task] Meta request', {
    url: redactGraphUrl(url),
    payload,
    tokenConfigured: Boolean(accessToken),
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const metaResponse = await readMetaResponse(response);
  console.log('[send-whatsapp-task] Meta response JSON', {
    status: response.status,
    ok: response.ok,
    body: metaResponse,
  });
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
    metaResponse: result.metaResponse,
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

function buildButtonLinkValue(link, mode) {
  const value = String(link || '').trim();
  if (!value) return value;
  if (mode === 'full') return value;

  try {
    const url = new URL(value);
    if (mode === 'path') return `${url.pathname}${url.search}${url.hash}`;
    if (mode === 'task') {
      return (
        url.searchParams.get('task') ||
        url.searchParams.get('task_id') ||
        url.pathname.split('/').filter(Boolean).pop() ||
        value
      );
    }
  } catch {
    // If link is already a suffix, keep it as-is for non-full modes.
    return value;
  }

  return value;
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

function logSendAttempt(label, details) {
  const bodyComponent = details.payload.template?.components?.find((c) => c.type === 'body');
  const buttonComponent = details.payload.template?.components?.find((c) => c.type === 'button');
  console.log(`[send-whatsapp-task] ${label} send attempt`, {
    phoneNumberIdLast4: details.phoneNumberIdLast4,
    to: details.payload.to,
    taskId: details.taskId || null,
    messageRecordId: details.messageRecordId || null,
    recipientName: details.recipientName || null,
    ownerName: details.ownerName,
    imagePathPresent: details.imagePathPresent,
    metaMediaId: details.metaMediaId || null,
    imageSendStatus: details.imageSendStatus,
    templateName: details.templateName,
    templateType: details.templateType,
    isFallback: details.isFallback,
    templateLanguage: details.templateLanguage,
    linkPlacement: details.linkPlacement,
    buttonValueMode: details.buttonValueMode || null,
    bodyParameterCount: bodyComponent?.parameters?.length ?? 0,
    buttonParameterCount: buttonComponent?.parameters?.length ?? 0,
    buttonIndex: buttonComponent?.index ?? null,
    payload: details.payload,
  });
}

function redactGraphUrl(url) {
  return String(url).replace(/graph\.facebook\.com\/v\d+\.\d+\/([^/]+)/, (_match, id) => {
    const value = String(id);
    return `graph.facebook.com/v20.0/...${value.slice(-4)}`;
  });
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
