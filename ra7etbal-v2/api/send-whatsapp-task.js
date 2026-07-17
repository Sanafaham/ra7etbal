import {
  beginWhatsappDelivery,
  getMetaFailure,
  markWhatsappDeliveryAccepted,
  markWhatsappDeliveryFailed,
} from './_whatsapp-delivery.js';

// Raise Vercel function timeout to 60 s so image download + Meta upload do not
// hit the default 15 s limit and kill the entire send-whatsapp-task request.
export const config = { maxDuration: 60 };

const DEFAULT_TEMPLATE_LANGUAGE = 'en';
const FALLBACK_OWNER_NAME = 'Rahet Bal';
const DEFAULT_PLAIN_MESSAGE_TEMPLATE = 'ra7etbal_routine_message';
const DEFAULT_DIRECT_MESSAGE_TEMPLATE = 'ra7etbal_direct_operational_message';
const OWNER_DECISION_TEMPLATE_NAME = 'ra7etbal_owner_decision';
const TASK_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const TASK_UUID_EXACT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

  const {
    to,
    messageText,
    confirmationLink,
    messageRecordId,
    taskId,
    routineId,
    automationRunId,
    sourceType,
    sendMode,
    recipientName,
    ownerName,
    imagePath,
    attachmentCount,
  } = req.body || {};

  const isRoutineMessage = sendMode === 'routine_message';
  const isDirectMessage = sendMode === 'direct_message';
  const usesPlainMessageTemplate = isRoutineMessage || isDirectMessage;
  if (isRoutineMessage) {
    const expectedSecret = process.env.CRON_SECRET;
    const providedSecret = req.headers?.['x-ra7etbal-internal-secret'];
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized routine message request.',
      });
    }
  }

  // Task templates are approved in 'en'. Routine messages preserve their
  // existing independently-approved language configuration. Direct messages
  // are a separately approved template and must not share the routine
  // template's language env var.
  const templateLanguage = isDirectMessage
    ? (process.env.WHATSAPP_DIRECT_MESSAGE_TEMPLATE_LANGUAGE || 'en').trim()
    : isRoutineMessage
      ? (process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US').trim()
      : DEFAULT_TEMPLATE_LANGUAGE;
  const normalizedTo = normalizeWhatsAppPhone(to);
  const cleanOwnerName = String(ownerName || '').trim() || FALLBACK_OWNER_NAME;
  const attachmentCountN = typeof attachmentCount === 'number' ? attachmentCount : 0;

  // When multiple photos are attached, append a note to the message body so
  // the recipient knows to open the confirmation link to view all photos.
  // The note is appended into the existing {{2}} body parameter of
  // ra7etbal_task_v3 — no template change needed.
  let cleanMessage = String(messageText || '').trim();
  if (attachmentCountN > 1) {
    cleanMessage = `${cleanMessage} — ${cleanOwnerName} attached ${attachmentCountN} photos. Open the task link to view them.`;
  }

  // Meta rejects newline/tab characters inside body template parameters
  // (error #132018). Collapse any whitespace runs — from the appended note or
  // from a multi-line message the user typed — into single spaces.
  cleanMessage = cleanMessage.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();

  const cleanLink = String(confirmationLink || '').trim();
  const phoneNumberIdLast4 = phoneNumberId ? phoneNumberId.slice(-4) : null;
  const deliverySourceType =
    typeof sourceType === 'string' && sourceType.trim()
      ? sourceType.trim()
      : taskId
        ? 'delegation'
        : 'message';

  const deliveryId = await beginWhatsappDelivery({
    supabaseUrl,
    serviceKey,
    messageRecordId,
    taskId,
    routineId,
    automationRunId,
    sourceType: deliverySourceType,
    recipientPhone: normalizedTo,
    recipientName: String(recipientName || '').trim() || null,
    metadata: {
      has_confirmation_link: Boolean(cleanLink),
      has_image: Boolean(imagePath),
      attachment_count: attachmentCountN,
      send_mode: isDirectMessage ? 'direct_message' : isRoutineMessage ? 'routine_message' : 'task_template',
      direct_message: isDirectMessage,
      // Stored only for automation_message rows so an async webhook-reported
      // failure (e.g. Meta 131049) can build an SMS fallback without a
      // separate lookup. Not stored for delegation/task/direct-message rows —
      // those already have a synchronous SMS fallback path that has the text
      // in scope, and we don't want to widen what's persisted unnecessarily.
      ...(deliverySourceType === 'automation_message' ? { message_text: cleanMessage } : {}),
    },
  });

  if (!accessToken || !phoneNumberId) {
    await markWhatsappDeliveryFailed({
      supabaseUrl,
      serviceKey,
      deliveryId,
      failureStage: 'configuration',
      reason: 'Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.',
    });
    return res.status(500).json({
      success: false,
      delivery_id: deliveryId,
      error: 'WhatsApp is not configured.',
      errorMessage: 'WhatsApp is not configured.',
      details: 'Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.',
    });
  }

  if (!normalizedTo) {
    await markWhatsappDeliveryFailed({
      supabaseUrl,
      serviceKey,
      deliveryId,
      failureStage: 'validation',
      reason: 'Recipient phone number is missing or invalid.',
    });
    return res.status(400).json({
      success: false,
      delivery_id: deliveryId,
      error: 'Recipient phone number is missing.',
      errorMessage: 'Recipient phone number is missing.',
      details: 'Add a WhatsApp phone number for this person, then retry.',
    });
  }

  if (!cleanMessage) {
    await markWhatsappDeliveryFailed({
      supabaseUrl,
      serviceKey,
      deliveryId,
      failureStage: 'validation',
      reason: 'Message text is missing.',
    });
    return res.status(400).json({
      success: false,
      delivery_id: deliveryId,
      error: 'Message text is missing.',
      errorMessage: 'Message text is missing.',
      details: 'Could not send an empty WhatsApp message.',
    });
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  if (isDirectMessage && !messageRecordId) {
    await markWhatsappDeliveryFailed({
      supabaseUrl,
      serviceKey,
      deliveryId,
      failureStage: 'validation',
      reason: 'Direct message requires a saved message record.',
    });
    return res.status(400).json({
      success: false,
      delivery_id: deliveryId,
      error: 'Direct message requires a saved message record.',
      errorMessage: 'Direct message requires a saved message record.',
      details: 'Save the message first so delivery ownership can be recorded.',
    });
  }

  if (isDirectMessage && taskId) {
    await markWhatsappDeliveryFailed({
      supabaseUrl,
      serviceKey,
      deliveryId,
      failureStage: 'validation',
      reason: 'Direct messages cannot include a task.',
    });
    return res.status(400).json({
      success: false,
      delivery_id: deliveryId,
      error: 'Direct messages cannot include a task.',
      errorMessage: 'Direct messages cannot include a task.',
      details: 'Task and delegation WhatsApp messages require a confirmation link.',
    });
  }

  if (!usesPlainMessageTemplate && !cleanLink) {
    await markWhatsappDeliveryFailed({
      supabaseUrl,
      serviceKey,
      deliveryId,
      failureStage: 'validation',
      reason: 'Confirmation link is missing.',
    });
    return res.status(400).json({
      success: false,
      delivery_id: deliveryId,
      error: 'Confirmation link is missing.',
      errorMessage: 'Confirmation link is missing.',
      details: 'WhatsApp task templates require a confirmation link.',
    });
  }

  // ── Direct message boundary ───────────────────────────────────────────────
  // Isolated from routine messages: its own template name, its own language,
  // and the approved direct-message template's own two-parameter body shape
  // (ownerName, messageText). Has no route to WHATSAPP_ROUTINE_MESSAGE_TEMPLATE,
  // DEFAULT_PLAIN_MESSAGE_TEMPLATE, or ra7etbal_routine_message.
  if (isDirectMessage) {
    const directTemplateName =
      (process.env.WHATSAPP_DIRECT_MESSAGE_TEMPLATE || DEFAULT_DIRECT_MESSAGE_TEMPLATE).trim();

    const directPayload = buildDirectMessagePayload({
      to: normalizedTo,
      ownerName: cleanOwnerName,
      message: cleanMessage,
      templateName: directTemplateName,
      templateLanguage,
    });

    try {
      const result = await sendMetaMessage({
        url,
        accessToken,
        payload: directPayload,
      });

      if (!result.ok) {
        const failure = getMetaFailure(result);
        await markWhatsappDeliveryFailed({
          supabaseUrl,
          serviceKey,
          deliveryId,
          failureStage: 'meta_api',
          ...failure,
          templateName: directTemplateName,
          metadata: { template_language: templateLanguage, send_mode: sendMode },
        });
        return sendFailure(res, result, null, deliveryId);
      }

      await markMessageAccepted({
        supabaseUrl,
        serviceKey,
        messageRecordId,
        messageId: result.messageId,
      });
      await markWhatsappDeliveryAccepted({
        supabaseUrl,
        serviceKey,
        deliveryId,
        metaMessageId: result.messageId,
        templateName: directTemplateName,
        metadata: {
          template_language: templateLanguage,
          send_mode: 'direct_message',
          direct_message: true,
        },
      });

      return res.status(200).json({
        success: true,
        delivery_id: deliveryId,
        sendMode: 'direct_message',
        sendType: 'template',
        channel: 'whatsapp',
        messageId: result.messageId,
        to: normalizedTo,
        acceptedAt: new Date().toISOString(),
        phoneNumberIdLast4,
        templateName: directTemplateName,
        templateLanguage,
      });
    } catch (err) {
      await markWhatsappDeliveryFailed({
        supabaseUrl,
        serviceKey,
        deliveryId,
        failureStage: 'network',
        reason: err instanceof Error ? err.message : String(err),
        templateName: directTemplateName,
        metadata: { template_language: templateLanguage, send_mode: sendMode },
      });
      return res.status(500).json({
        success: false,
        delivery_id: deliveryId,
        error: 'Could not send WhatsApp message.',
        errorMessage: 'Could not send WhatsApp message.',
        details: err instanceof Error ? err.message : 'Unexpected server error.',
      });
    }
  }

  // ── Routine message boundary ──────────────────────────────────────────────
  // Preserves the existing approved routine-message template payload exactly:
  // one body parameter, no task, no confirmation link, no SMS fallback.
  // Used by recurring automations. Unchanged by this fix.
  if (isRoutineMessage) {
    const plainTemplateName =
      (process.env.WHATSAPP_ROUTINE_MESSAGE_TEMPLATE || DEFAULT_PLAIN_MESSAGE_TEMPLATE).trim();

    const routinePayload = buildRoutineMessagePayload({
      to: normalizedTo,
      message: cleanMessage,
      templateName: plainTemplateName,
      templateLanguage,
    });

    try {
      const result = await sendMetaMessage({
        url,
        accessToken,
        payload: routinePayload,
      });

      if (!result.ok) {
        const failure = getMetaFailure(result);
        await markWhatsappDeliveryFailed({
          supabaseUrl,
          serviceKey,
          deliveryId,
          failureStage: 'meta_api',
          ...failure,
          templateName: plainTemplateName,
          metadata: { template_language: templateLanguage, send_mode: sendMode },
        });
        return sendFailure(res, result, null, deliveryId);
      }

      await markWhatsappDeliveryAccepted({
        supabaseUrl,
        serviceKey,
        deliveryId,
        metaMessageId: result.messageId,
        templateName: plainTemplateName,
        metadata: {
          template_language: templateLanguage,
          send_mode: 'routine_message',
          direct_message: false,
        },
      });

      return res.status(200).json({
        success: true,
        delivery_id: deliveryId,
        sendMode: 'template',
        sendType: 'template',
        channel: 'whatsapp',
        messageId: result.messageId,
        to: normalizedTo,
        acceptedAt: new Date().toISOString(),
        phoneNumberIdLast4,
        templateName: plainTemplateName,
        templateLanguage,
      });
    } catch (err) {
      await markWhatsappDeliveryFailed({
        supabaseUrl,
        serviceKey,
        deliveryId,
        failureStage: 'network',
        reason: err instanceof Error ? err.message : String(err),
        templateName: plainTemplateName,
        metadata: { template_language: templateLanguage, send_mode: sendMode },
      });
      return res.status(500).json({
        success: false,
        delivery_id: deliveryId,
        error: 'Could not send WhatsApp message.',
        errorMessage: 'Could not send WhatsApp message.',
        details: err instanceof Error ? err.message : 'Unexpected server error.',
      });
    }
  }

  // ── Template selection ────────────────────────────────────────────────────
  // Text tasks (no imagePath):
  //   PRIMARY:  ra7etbal_task_v3    (3 params: owner, message, link)
  //   FALLBACK: ra7etbal_task_v3    (same template, different link placement variants)
  //
  // Single-image tasks (imagePath present, attachmentCount <= 1):
  //   PRIMARY:  ra7etbal_task_image (image header + 3 body params: owner, message, link)
  //   FALLBACK: ra7etbal_task_v3   + separate image media message (if Meta upload fails)
  //
  // Multi-image tasks (attachmentCount > 1):
  //   PRIMARY:  ra7etbal_task_v3   (attachment note already appended to cleanMessage above)
  //   No image header — Meta only supports one media header per template.
  const isMultiAttachment = attachmentCountN > 1;
  const primaryTemplateName = (imagePath && !isMultiAttachment) ? 'ra7etbal_task_image' : 'ra7etbal_task_v3';
  const fallbackTemplateName = 'ra7etbal_task_v3';

  // ── Image upload for ra7etbal_task_image ──────────────────────────────────
  // For image tasks, attempt to upload the image to Meta and use it in the
  // image-header template. If upload fails, fall through to legacy behavior
  // (separate image media message + ra7etbal_task_assignment).
  let metaMediaId = null;     // set if Meta upload succeeds
  let imageSignedUrl = null;  // set if signed URL generation succeeds
  let imageSendStatus = 'skipped'; // skipped | uploaded | sent | failed | no_signed_url

  if (imagePath && !isMultiAttachment) {
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
  const useImageTemplate = imagePath && metaMediaId !== null && !isMultiAttachment;
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
  // When a single-image task could not be delivered via the ra7etbal_task_image
  // template (Meta media upload failed or timed out), append a plain-language
  // note into the message body so the assignee knows a photo is waiting for
  // them on the confirmation page. This is Option B: "Photo is on the task
  // page — tap the button to view it." The confirmation page always shows
  // image_path for single-image tasks so the photo is guaranteed viewable.
  //
  // The legacy path that sent `{ image: { link: signedUrl } }` as a separate
  // WhatsApp media message has been removed. Meta's Business API consistently
  // rejects URL-based image messages when the URL contains a token query
  // parameter (e.g. Supabase signed URLs). It added latency, caused delivery
  // failures, and appended a raw signed URL into the message text as a fallback
  // — none of which reached the assignee in a useful form.
  if (imagePath && !metaMediaId && !isMultiAttachment) {
    console.log('[send-whatsapp-task] image template upload failed; appending photo-on-link note', {
      imageSendStatus,
      imagePathPresent: Boolean(imagePath),
    });
    imageSendStatus = 'task_link_fallback';
    cleanMessage = `${cleanMessage} — There is also a photo on this task. Open the link to view it.`;
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
      { label: 'primary-body-link', templateName: effectivePrimaryTemplate, isFallback: false, linkPlacement: 'body', mediaId: metaMediaId },
      { label: 'fallback-body-link', templateName: fallbackTemplateName, isFallback: true, linkPlacement: 'body', mediaId: null },
      { label: 'primary-button-full', templateName: effectivePrimaryTemplate, isFallback: false, linkPlacement: 'button', buttonValueMode: 'full', mediaId: metaMediaId },
      { label: 'primary-button-path', templateName: effectivePrimaryTemplate, isFallback: false, linkPlacement: 'button', buttonValueMode: 'path', mediaId: metaMediaId },
      { label: 'primary-button-task', templateName: effectivePrimaryTemplate, isFallback: false, linkPlacement: 'button', buttonValueMode: 'task', mediaId: metaMediaId },
      { label: 'fallback-button-full', templateName: fallbackTemplateName, isFallback: true, linkPlacement: 'button', buttonValueMode: 'full', mediaId: null },
      { label: 'fallback-button-path', templateName: fallbackTemplateName, isFallback: true, linkPlacement: 'button', buttonValueMode: 'path', mediaId: null },
      { label: 'fallback-button-task', templateName: fallbackTemplateName, isFallback: true, linkPlacement: 'button', buttonValueMode: 'task', mediaId: null },
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
      const failure = getMetaFailure(templateResult);
      await markWhatsappDeliveryFailed({
        supabaseUrl,
        serviceKey,
        deliveryId,
        failureStage: 'meta_api',
        ...failure,
        templateName: usedTemplateName,
        metadata: {
          attempt_count: attempts.indexOf(usedAttempt) + 1,
          last_attempt: usedAttempt?.label ?? null,
        },
      });

      // ── SMS fallback via Twilio ───────────────────────────────────────────
      const smsFallbackEnabled = process.env.SMS_FALLBACK_ENABLED === 'true';
      const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
      const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
      const twilioFromNumber = process.env.TWILIO_FROM_NUMBER;

      if (smsFallbackEnabled && twilioAccountSid && twilioAuthToken && twilioFromNumber && normalizedTo) {
        console.log('[send-whatsapp-task] WhatsApp failed — attempting SMS fallback', { to: normalizedTo });
        const smsBody = buildSmsBody({ ownerName: cleanOwnerName, messageText: cleanMessage, confirmationLink: cleanLink });
        const smsResult = await sendTwilioSms({
          to: normalizedTo,
          body: smsBody,
          accountSid: twilioAccountSid,
          authToken: twilioAuthToken,
          fromNumber: twilioFromNumber,
        });

        if (smsResult.ok) {
          console.log('[send-whatsapp-task] SMS fallback accepted', { sid: smsResult.sid });
          await markMessageAccepted({ supabaseUrl, serviceKey, messageRecordId, messageId: smsResult.sid, channel: 'sms' });
          await markWhatsappDeliveryAccepted({
            supabaseUrl,
            serviceKey,
            deliveryId,
            metaMessageId: smsResult.sid,
            templateName: 'sms_fallback',
            metadata: {
              channel: 'sms',
              whatsapp_failed: true,
              fallback_from_template: usedTemplateName,
              fallback_attempt: usedAttempt?.label ?? null,
            },
          });
          return res.status(200).json({
            success: true,
            delivery_id: deliveryId,
            sendMode: 'sms',
            sendType: 'sms',
            channel: 'sms',
            messageId: smsResult.sid,
            to: normalizedTo,
            acceptedAt: new Date().toISOString(),
          });
        }

        console.error('[send-whatsapp-task] SMS fallback also failed', { error: smsResult.error });
        return res.status(502).json({
          success: false,
          delivery_id: deliveryId,
          error: 'I saved the task, but I could not send it by WhatsApp or SMS.',
          errorMessage: 'I saved the task, but I could not send it by WhatsApp or SMS.',
        });
      }

      return sendFailure(res, templateResult, null, deliveryId);
    }

    console.log('[send-whatsapp-task] send accepted', {
      templateName: usedTemplateName,
      isFallback: Boolean(usedAttempt?.isFallback),
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
    await markWhatsappDeliveryAccepted({
      supabaseUrl,
      serviceKey,
      deliveryId,
      metaMessageId: templateResult.messageId,
      templateName: usedTemplateName,
      metadata: {
        attempt_count: attempts.indexOf(usedAttempt) + 1,
        accepted_attempt: usedAttempt?.label ?? null,
        template_language: templateLanguage,
        image_send_status: imageSendStatus,
      },
    });

    return res.status(200).json({
      success: true,
      delivery_id: deliveryId,
      sendMode: 'template',
      sendType: 'template',
      channel: 'whatsapp',
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
    await markWhatsappDeliveryFailed({
      supabaseUrl,
      serviceKey,
      deliveryId,
      failureStage: 'network',
      reason: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      delivery_id: deliveryId,
      error: 'Could not send WhatsApp message.',
      errorMessage: 'Could not send WhatsApp message.',
      details: err instanceof Error ? err.message : 'Unexpected server error.',
    });
  }
}

export function buildRoutineMessagePayload({
  to,
  message,
  templateName,
  templateLanguage,
  buttonUrlSuffix,
}) {
  if (isOwnerDecisionTemplateName(templateName)) {
    throw new Error('Owner decision WhatsApp template requires buildOwnerDecisionTemplatePayload.');
  }

  const components = [
    {
      type: 'body',
      parameters: [{ type: 'text', text: message }],
    },
  ];

  if (buttonUrlSuffix) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: buttonUrlSuffix }],
    });
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLanguage },
      components,
    },
  };
}

// The approved direct-message Utility template body is:
//   Operational update from {{1}}:
//   {{2}}
//   Thank you.
// It requires exactly two body parameters (ownerName, messageText) — a
// separate shape from buildRoutineMessagePayload's single-parameter body,
// so direct messages get their own builder rather than reusing that one.
export function buildDirectMessagePayload({
  to,
  ownerName,
  message,
  templateName,
  templateLanguage,
}) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLanguage },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: ownerName },
            { type: 'text', text: message },
          ],
        },
      ],
    },
  };
}

function isOwnerDecisionTemplateName(templateName) {
  const name = String(templateName || '').trim();
  const configuredName = String(process.env.WHATSAPP_OWNER_DECISION_TEMPLATE || '').trim();
  return name === OWNER_DECISION_TEMPLATE_NAME || (configuredName && name === configuredName);
}

/** Extracts one task UUID for a WhatsApp dynamic URL button, without preserving surrounding URL or body text. */
export function normalizeTaskUuidForButton(value) {
  let text = String(value || '').trim();
  if (!text) return '';

  for (let depth = 0; depth < 4; depth += 1) {
    for (let i = 0; i < 3; i += 1) {
      try {
        const decoded = decodeURIComponent(text);
        if (decoded === text) break;
        text = decoded.trim();
      } catch {
        break;
      }
    }

    try {
      const url = new URL(text);
      const nestedTask = url.searchParams.get('task') || url.searchParams.get('task_id');
      if (nestedTask && nestedTask.trim() !== text) {
        text = nestedTask.trim();
        continue;
      }
    } catch {
      // Not a full URL; fall through to UUID extraction.
    }

    break;
  }

  return text.match(TASK_UUID_RE)?.[0] || '';
}

/** Builds the owner-decision Utility template with message text in body and UUID-only Visit Task suffix. */
export function buildOwnerDecisionTemplatePayload({
  to,
  message,
  templateName,
  templateLanguage,
  taskId,
  taskUuid,
}) {
  const buttonTaskUuid = TASK_UUID_EXACT_RE.test(String(taskUuid || ''))
    ? String(taskUuid).trim()
    : normalizeTaskUuidForButton(taskId);
  if (!buttonTaskUuid) {
    throw new Error('Owner decision Visit Task button requires a task UUID.');
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLanguage },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: message }],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: buttonTaskUuid }],
        },
      ],
    },
  };
}

export async function sendMetaMessage({ url, accessToken, payload }) {
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
    ok: response.ok && Boolean(messageId),
    status: response.status,
    metaResponse,
    metaError: response.ok && !messageId
      ? { message: 'Meta accepted the request but returned no WhatsApp message id.' }
      : metaResponse?.error || metaResponse,
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

function sendFailure(res, result, freeFormError = null, deliveryId = null) {
  const errorMessage = safeMetaMessage(result.metaError);
  const httpStatus = result.status >= 400 ? result.status : 502;
  return res.status(httpStatus).json({
    success: false,
    delivery_id: deliveryId,
    status: result.status || 502,
    error: 'Could not send WhatsApp message.',
    errorMessage,
    metaResponse: result.metaResponse,
    metaError: result.metaError,
    details: errorMessage,
    freeFormError,
  });
}

export function normalizeWhatsAppPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return null;

  let digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return digits.length >= 7 ? digits : null;
}

export function buildButtonLinkValue(link, mode) {
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

export async function markMessageAccepted({
  supabaseUrl,
  serviceKey,
  messageRecordId,
  messageId,
  channel = 'whatsapp',
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
        whatsapp_delivery_status: channel === 'sms' ? 'sms_sent' : 'sent',
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

  // Each network call (download + upload) gets its own abort controller so a
  // single slow Meta or Supabase response does not hang the entire function.
  // 8 s per step keeps the total well inside the 60 s Vercel limit while still
  // giving each call a reasonable window on slow connections.
  const STEP_TIMEOUT_MS = 8_000;

  try {
    // ── Step 1: download image from Supabase signed URL ──────────────────────
    const downloadAbort = new AbortController();
    const downloadTimer = setTimeout(() => downloadAbort.abort(), STEP_TIMEOUT_MS);
    let imageResponse;
    try {
      imageResponse = await fetch(imageUrl, { signal: downloadAbort.signal });
    } finally {
      clearTimeout(downloadTimer);
    }
    if (!imageResponse.ok) {
      console.warn('[send-whatsapp-task] uploadImageToMeta: image download failed', {
        status: imageResponse.status,
      });
      return null;
    }
    console.log('[send-whatsapp-task] uploadImageToMeta: image downloaded', {
      status: imageResponse.status,
      contentType: imageResponse.headers.get('content-type'),
    });

    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = await imageResponse.arrayBuffer();
    console.log('[send-whatsapp-task] uploadImageToMeta: image buffered', {
      bytes: imageBuffer.byteLength,
    });

    // ── Step 2: upload to Meta media endpoint ────────────────────────────────
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', contentType);
    formData.append(
      'file',
      new Blob([imageBuffer], { type: contentType }),
      'task-image.jpg',
    );

    const uploadUrl = `https://graph.facebook.com/v20.0/${phoneNumberId}/media`;
    const uploadAbort = new AbortController();
    const uploadTimer = setTimeout(() => uploadAbort.abort(), STEP_TIMEOUT_MS);
    let uploadResponse;
    try {
      uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
        signal: uploadAbort.signal,
      });
    } finally {
      clearTimeout(uploadTimer);
    }

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text().catch(() => '');
      console.warn('[send-whatsapp-task] uploadImageToMeta: Meta upload failed', {
        status: uploadResponse.status,
        body: errText.slice(0, 300),
      });
      return null;
    }

    const data = await uploadResponse.json();
    const mediaId = data?.id || null;
    console.log('[send-whatsapp-task] uploadImageToMeta: Meta upload succeeded', {
      mediaId,
    });
    return mediaId;
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    console.warn('[send-whatsapp-task] uploadImageToMeta threw', {
      message: err?.message ?? String(err),
      aborted: isAbort,
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

export function buildSmsBody({ ownerName, messageText, confirmationLink }) {
  const parts = [];
  if (ownerName) parts.push(`From ${ownerName}:`);
  parts.push(String(messageText || '').trim());
  if (confirmationLink) parts.push(`\nWhen done, tap here:\n${confirmationLink}`);
  return parts.join('\n');
}

export async function sendTwilioSms({ to, body, accountSid, authToken, fromNumber }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({ From: fromNumber, To: `+${to}`, Body: body });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, sid: data?.sid ?? null, error: data?.message ?? null };
  } catch (err) {
    return { ok: false, sid: null, error: err?.message ?? String(err) };
  }
}
