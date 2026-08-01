import {
  callRpcRows,
  callRpcSingle,
  resolveAndDeliverEscalationAnswer,
} from './task-confirm.js';
import { sendMetaMessage } from './send-whatsapp-task.js';
import { persistAndExecuteOwnerCommand, recordOwnerInbound, updateCommand } from './_owner-command-executor.js';
import { classifyOwnerWhatsAppIntent, isExecutionDomain } from './_carson-intent-classifier.js';
import { runOwnerConversationalTurn } from './_carson-agent-turn.js';

const RECEIPT_LEASE_SECONDS = 120;

// ---------------------------------------------------------------------------
// Image understanding pipeline
// ---------------------------------------------------------------------------

/**
 * Downloads a WhatsApp media item, uploads it to Supabase Storage, and runs a
 * single Anthropic vision call.  Returns a structured `imageUnderstanding`
 * object that downstream routing and execution code can use without re-fetching
 * or re-running the model.
 *
 * Failure is non-fatal: callers should fall back to caption-only processing
 * when this returns null.
 */
export async function analyzeOwnerWhatsAppImage({
  mediaId,
  mimeType,
  userId,
  messageId,
  accessToken,
  anthropicApiKey,
  supabaseUrl,
  serviceKey,
}) {
  // ── 1. Resolve download URL from WhatsApp Media API ────────────────────
  const mediaMetaRes = await fetch(
    `https://graph.facebook.com/v20.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!mediaMetaRes.ok) {
    console.warn('[owner_image] WhatsApp media metadata fetch failed', {
      messageId, mediaId, status: mediaMetaRes.status,
    });
    return null;
  }
  const mediaMeta = await mediaMetaRes.json().catch(() => null);
  const downloadUrl = mediaMeta?.url;
  if (!downloadUrl) {
    console.warn('[owner_image] WhatsApp media URL missing', { messageId, mediaId });
    return null;
  }

  // ── 2. Download image bytes ─────────────────────────────────────────────
  const downloadRes = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!downloadRes.ok) {
    console.warn('[owner_image] WhatsApp image download failed', {
      messageId, status: downloadRes.status,
    });
    return null;
  }
  const imageBuffer = await downloadRes.arrayBuffer();
  const imageBytes  = Buffer.from(imageBuffer);

  // ── 3. Upload to Supabase Storage so the image survives for delegation ──
  const ext         = resolveImageExtension(mimeType);
  const storagePath = `${userId}/whatsapp-inbound/${messageId}${ext}`;
  const uploadRes   = await fetch(
    `${supabaseUrl}/storage/v1/object/task-images/${storagePath}`,
    {
      method:  'POST',
      headers: {
        apikey:          serviceKey,
        Authorization:   `Bearer ${serviceKey}`,
        'Content-Type':  mimeType || 'image/jpeg',
        'Cache-Control': '3600',
        'x-upsert':      'true',
      },
      body: imageBytes,
    },
  );
  if (!uploadRes.ok) {
    const details = await uploadRes.text().catch(() => '');
    console.warn('[owner_image] Supabase Storage upload failed', {
      messageId, storagePath, status: uploadRes.status, details,
    });
    // Non-fatal — vision can still run; delegation without image is the fallback.
  }
  const storageFullPath = uploadRes.ok ? `task-images/${storagePath}` : null;

  // ── 4. Run Anthropic vision analysis ────────────────────────────────────
  const base64 = imageBytes.toString('base64');
  const safeMediaType = resolveAnthropicMediaType(mimeType);

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          {
            type:   'image',
            source: { type: 'base64', media_type: safeMediaType, data: base64 },
          },
          {
            type: 'text',
            text: [
              'Analyze this image for a household assistant app.',
              'Return only valid JSON with these fields:',
              '- substitution: a brief, concrete noun phrase to replace "this/it" in a command (e.g. "one pack of TEREA Turquoise for IQOS ILUMA", "the grilled salmon dish", "a carton of full-fat milk")',
              '- description: a one-sentence description of the main subject',
              '- ocr: any text visible in the image (empty string if none)',
              '- confidence: your confidence that the main subject is correctly identified (0–1)',
            ].join(' '),
          },
        ],
      }],
    }),
  });

  if (!anthropicRes.ok) {
    console.warn('[owner_image] Anthropic vision call failed', {
      messageId, status: anthropicRes.status,
    });
    return null;
  }

  let understanding = null;
  try {
    const anthropicBody = await anthropicRes.json();
    const raw = anthropicBody?.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      understanding = JSON.parse(jsonMatch[0]);
    }
  } catch {
    console.warn('[owner_image] Anthropic vision response parse failed', { messageId });
    return null;
  }

  const result = {
    description:  String(understanding?.description  || '').trim(),
    substitution: String(understanding?.substitution || '').trim(),
    ocr:          String(understanding?.ocr          || '').trim(),
    confidence:   Number(understanding?.confidence   ?? 0),
    storagePath:  storageFullPath,
  };

  console.log('[owner_image] vision analysis complete', {
    messageId,
    hasDescription:  Boolean(result.description),
    hasSubstitution: Boolean(result.substitution),
    hasOcr:          Boolean(result.ocr),
    confidence:      result.confidence,
    hasStoragePath:  Boolean(result.storagePath),
  });

  return result;
}

/**
 * Merges the original caption with image understanding to produce a concrete
 * instruction for routing and execution.  The original `msg.body` is never
 * mutated; callers use this only as the reasoning text.
 */
export function buildEnrichedCommand(originalBody, imageUnderstanding) {
  const sub = imageUnderstanding?.substitution || imageUnderstanding?.description || '';
  if (!sub) return originalBody || '';
  if (!originalBody) return sub;

  // Replace the first proximal reference ("this", "it", "these", "that", "those")
  // with the concrete substitution phrase from vision analysis.
  const proximalRe = /\b(this|it|these|that|those)\b/i;
  if (proximalRe.test(originalBody)) {
    return originalBody.replace(proximalRe, sub);
  }

  // Caption is self-sufficient (no proximal reference) — append image context
  // for reasoning but keep the caption as the primary instruction.
  return `${originalBody} (Image: ${sub})`;
}

function resolveImageExtension(mimeType) {
  if (!mimeType) return '.jpg';
  if (mimeType.includes('png'))  return '.png';
  if (mimeType.includes('webp')) return '.webp';
  if (mimeType.includes('gif'))  return '.gif';
  return '.jpg';
}

function resolveAnthropicMediaType(mimeType) {
  if (!mimeType) return 'image/jpeg';
  const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  return supported.includes(mimeType) ? mimeType : 'image/jpeg';
}
const UNMATCHED_QUOTE_TEXT =
  "I couldn't identify the staff question you replied to. Please reply directly to the latest message about that request.";
const DELIVERY_FAILED_TEXT =
  "I saved your answer, but I couldn't deliver it to the staff member yet. Please try again shortly.";
const QUOTED_COMPOUND_TEXT =
  "I couldn't safely separate your answer from the additional command. Nothing was sent. Please reply to the staff question only, then send the other command separately.";
const DECISION_LOOKBACK_DAYS = 14;
const DISAMBIGUATION_TTL_MS = 10 * 60 * 1000;
const DISAMBIGUATION_EXPIRED_TEXT =
  'That decision clarification has expired. Please reply to the decision request again with your answer.';
const DISAMBIGUATION_STILL_AMBIGUOUS_TEXT =
  'I still cannot tell which decision you mean. Please say the first one, the second one, or name the request.';
const DISAMBIGUATION_ALREADY_HANDLED_TEXT =
  'That decision clarification is already being handled. I did not send another answer.';
const DISAMBIGUATION_CONTEXT_UNAVAILABLE_TEXT =
  'I identified the decision, but could not load its staff context. Nothing was sent. Please try again.';

/**
 * Safe owner WhatsApp boundary for Slice 1.
 *
 * Decision correlation is strict and ordered: quoted Meta context id, an
 * explicit UUID identifier, then exactly one recently-notified open decision.
 * A decision-shaped message with multiple matches gets clarification; it is
 * never guessed. Messages that are not decision-shaped retain the existing
 * general-command behavior.
 */
export async function handleInboundOwnerMessage({ supabaseUrl, serviceKey, msg }) {
  let identity;
  try {
    identity = await resolveCanonicalOwner({ supabaseUrl, serviceKey, msg });
  } catch {
    // Fail closed. If account identity storage is unavailable, do not let a
    // possible owner message fall through into consent or staff side effects.
    return { isOwner: true, handled: false, route: 'identity_error', reason: 'identity_lookup_failed' };
  }
  if (!identity.routingEnabled) return identity;
  if (identity.possibleOwner) {
    return { isOwner: true, handled: false, route: 'identity_ambiguous', reason: identity.reason };
  }
  if (!identity.isOwner) return identity;

  const receipt = await claimReceipt({
    supabaseUrl,
    serviceKey,
    userId: identity.userId,
    externalMessageId: msg.messageId,
  });
  if (!receipt.ok) {
    return { isOwner: true, handled: false, route: 'receipt_error', reason: receipt.reason };
  }
  if (!receipt.row.claimed) {
    return {
      isOwner: true,
      handled: true,
      route: 'duplicate',
      reason: receipt.row.status === 'completed' ? 'already_completed' : 'lease_held_elsewhere',
    };
  }

  // ── Vision enrichment (Step 2 & 3) ────────────────────────────────────────
  // When the owner sends an image, analyze it once here and produce an enriched
  // command for routing/execution. The original msg is never mutated; imageUnderstanding
  // and effectiveMsg carry the enriched context downstream.
  let imageUnderstanding = null;
  if (msg.mediaId) {
    imageUnderstanding = await analyzeOwnerWhatsAppImage({
      mediaId:       msg.mediaId,
      mimeType:      msg.mimeType,
      userId:        identity.userId,
      messageId:     msg.messageId,
      accessToken:   process.env.WHATSAPP_ACCESS_TOKEN,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      supabaseUrl,
      serviceKey,
    }).catch((err) => {
      console.warn('[owner_image] vision analysis threw (non-fatal, proceeding with caption)', {
        messageId: msg.messageId, error: err?.message || String(err),
      });
      return null;
    });
  }

  const effectiveBody = imageUnderstanding
    ? buildEnrichedCommand(msg.body, imageUnderstanding)
    : msg.body;

  // effectiveMsg is used everywhere downstream for reasoning.
  // msg.body (the original caption) is preserved in msg.
  const effectiveMsg = imageUnderstanding
    ? { ...msg, body: effectiveBody, imageUnderstanding, imageStoragePath: imageUnderstanding.storagePath }
    : msg;

  let match;
  try {
    match = effectiveMsg.contextMessageId || !isDisambiguationSelectorMessage(effectiveMsg.body)
      ? await matchOwnerDecision({ supabaseUrl, serviceKey, userId: identity.userId, msg: effectiveMsg })
      : await matchPendingDisambiguation({
          supabaseUrl,
          serviceKey,
          userId: identity.userId,
          selectorText: effectiveMsg.body,
          selectorReceiptId: receipt.row.receipt_id,
        }) || await matchOwnerDecision({
          supabaseUrl, serviceKey, userId: identity.userId, msg: effectiveMsg,
        });
  } catch (error) {
    await failReceipt({ supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row, error });
    return { isOwner: true, handled: false, route: 'owner_decision', reason: 'correlation_failed' };
  }

  let durableInbound = null;
  if (match.kind !== 'general') {
    const recorded = await recordOwnerInbound({
      supabaseUrl, serviceKey, identity, msg: effectiveMsg, receipt: receipt.row, route: 'quoted_escalation',
    });
    if (recorded.error) {
      await failReceipt({
        supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
        error: recorded.error.message || 'quoted_reply_record_failed',
      });
      return { isOwner: true, handled: false, route: 'quoted_escalation', reason: 'durability_failed' };
    }
    durableInbound = recorded.data;
  }

  if (match.kind === 'general') {
    // Classify intent to route between the command executor and Carson's
    // conversational bridge. classifyOwnerCommand (inside the executor) stays
    // as the internal execution validator — this router only decides the path.
    const intent = classifyOwnerWhatsAppIntent(effectiveMsg.body);
    console.log('[owner_whatsapp_routing] intent classified', {
      primary_domain: intent.primary_domain,
      isExecutionDomain: intent.isExecutionDomain,
      confidence: intent.confidence,
      messageId: effectiveMsg.messageId,
    });

    if (isExecutionDomain(intent)) {
      // Structured command — hand off to the existing executor unchanged.
      const result = await persistAndExecuteOwnerCommand({
        supabaseUrl, serviceKey, identity, msg: effectiveMsg, receipt: receipt.row,
      });
      if (!result.acknowledgement) {
        await failReceipt({
          supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
          error: result.error || 'command_record_failed',
        });
        return { isOwner: true, handled: false, route: 'general_command', reason: result.kind };
      }
      const ack = result.acknowledgementAlreadyAccepted
        ? { ok: true, alreadyAccepted: true }
        : await sendOwnerAcknowledgement({
            phoneNumberId: effectiveMsg.phoneNumberId, to: identity.ownerPhone, text: result.acknowledgement,
          });
      if (!ack.ok) {
        await updateCommand(supabaseUrl, serviceKey, receipt.row, identity.userId, {
          acknowledgement_status: 'failed',
          acknowledgement_error: ack.reason || 'owner_ack_failed',
          next_retry_at: new Date(Date.now() + 60_000).toISOString(),
        }).catch(() => {});
        await failReceipt({
          supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
          error: ack.reason || 'owner_ack_failed',
        });
        return { isOwner: true, handled: false, route: 'general_command', reason: 'owner_ack_failed' };
      }
      if (!ack.alreadyAccepted) {
        await updateCommand(supabaseUrl, serviceKey, receipt.row, identity.userId, {
          acknowledgement_status: 'accepted',
          acknowledgement_text: result.acknowledgement,
          acknowledgement_transport_message_id: ack.messageId,
        });
      }
      if (result.kind === 'execution_failed') {
        await failReceipt({
          supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
          error: result.error || 'command_execution_failed',
        });
        return {
          isOwner: true,
          handled: false,
          route: 'general_command',
          execution: result.kind,
          reason: 'command_execution_failed',
        };
      }
      const completed = await completeReceipt({
        supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
        outcome: result.kind === 'unsupported'
          ? 'unsupported_command'
          : result.kind === 'terminal_failed'
            ? 'terminal_failure'
            : 'general_command_executed',
        escalationId: null,
      });
      return {
        isOwner: true,
        handled: completed,
        route: 'general_command',
        execution: result.kind,
        reason: completed ? result.kind : 'receipt_complete_failed',
      };
    }

    // Conversational message — route to the Carson bridge.
    const conversationalResult = await runOwnerConversationalTurn({
      supabaseUrl,
      serviceKey,
      identity,
      msg: effectiveMsg,
      receipt: receipt.row,
      completeReceipt,
      failReceipt,
    });
    return { isOwner: true, ...conversationalResult };
  }

  if ([
    'disambiguation_expired',
    'disambiguation_ambiguous',
    'disambiguation_in_progress',
    'disambiguation_already_resolved',
    'disambiguation_context_unavailable',
  ].includes(match.kind)) {
    const clarification = match.kind === 'disambiguation_expired'
      ? DISAMBIGUATION_EXPIRED_TEXT
      : match.kind === 'disambiguation_ambiguous'
        ? DISAMBIGUATION_STILL_AMBIGUOUS_TEXT
        : match.kind === 'disambiguation_context_unavailable'
          ? DISAMBIGUATION_CONTEXT_UNAVAILABLE_TEXT
          : DISAMBIGUATION_ALREADY_HANDLED_TEXT;
    const ack = durableInbound?.acknowledgement_status === 'accepted' &&
      durableInbound?.acknowledgement_text === clarification
      ? { ok: true, alreadyAccepted: true }
      : await sendOwnerAcknowledgement({
          phoneNumberId: effectiveMsg.phoneNumberId,
          to: identity.ownerPhone,
          text: clarification,
        });
    if (!ack.ok) {
      await failReceipt({
        supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
        error: ack.reason || 'owner_ack_failed',
      });
      return { isOwner: true, handled: false, route: 'owner_decision_disambiguation', reason: 'owner_ack_failed' };
    }
    if (!ack.alreadyAccepted) {
      await updateCommand(supabaseUrl, serviceKey, receipt.row, identity.userId, {
        execution_status: 'unsupported',
        execution_result: {
          command_type: 'owner_decision',
          match_method: match.kind,
          clarification_receipt_id: match.clarificationReceiptId || null,
        },
        acknowledgement_status: 'accepted',
        acknowledgement_text: clarification,
        acknowledgement_transport_message_id: ack.messageId,
      });
    }
    const completed = await completeReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      outcome: 'clarification_sent', escalationId: null,
    });
    return {
      isOwner: true,
      handled: completed,
      route: 'owner_decision_disambiguation',
      reason: completed ? match.kind : 'receipt_complete_failed',
    };
  }

  if (match.kind === 'unmatched_quote' || match.kind === 'unmatched_identifier') {
    const clarification = match.kind === 'unmatched_quote'
      ? UNMATCHED_QUOTE_TEXT
      : "I couldn't identify that decision. Please use the decision link or reply directly to the decision message.";
    const ack = durableInbound?.acknowledgement_status === 'accepted' &&
      durableInbound?.acknowledgement_text === clarification
      ? { ok: true, alreadyAccepted: true }
      : await sendOwnerAcknowledgement({
          phoneNumberId: effectiveMsg.phoneNumberId,
          to: identity.ownerPhone,
          text: clarification,
        });
    if (!ack.ok) {
      await markRetryable({ supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row, error: ack.reason });
      await failReceipt({
        supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
        error: ack.reason || 'owner_ack_failed',
      });
      return { isOwner: true, handled: false, route: 'unmatched_quote', reason: 'owner_ack_failed' };
    }
    if (!ack.alreadyAccepted) {
      await updateCommand(supabaseUrl, serviceKey, receipt.row, identity.userId, {
        acknowledgement_status: 'accepted',
        acknowledgement_text: clarification,
        acknowledgement_transport_message_id: ack.messageId,
      });
    }
    const completed = await completeReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      outcome: 'clarification_sent', escalationId: null,
    });
    return {
      isOwner: true,
      handled: completed,
      route: match.kind,
      reason: completed ? 'clarification_sent' : 'receipt_complete_failed',
    };
  }

  if (match.kind === 'ambiguous') {
    const clarification = buildAmbiguityText(match.matches);
    const ack = durableInbound?.acknowledgement_status === 'accepted' &&
      durableInbound?.acknowledgement_text === clarification
      ? { ok: true, alreadyAccepted: true }
      : await sendOwnerAcknowledgement({
          phoneNumberId: effectiveMsg.phoneNumberId, to: identity.ownerPhone, text: clarification,
        });
    if (!ack.ok) {
      await failReceipt({
        supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
        error: ack.reason || 'owner_ack_failed',
      });
      return { isOwner: true, handled: false, route: 'owner_decision', reason: 'owner_ack_failed' };
    }
    if (!ack.alreadyAccepted) {
      await updateCommand(supabaseUrl, serviceKey, receipt.row, identity.userId, {
        execution_status: 'unsupported',
        execution_result: {
          command_type: 'owner_decision',
          match_method: 'ambiguous',
          clarification_status: 'pending',
          original_answer: msg.body.trim().slice(0, 1000),
          expires_at: new Date(Date.now() + DISAMBIGUATION_TTL_MS).toISOString(),
          candidates: match.matches.slice(0, 2).map(({ escalation, staffMessage }) => ({
            decision_id: escalation.id,
            staff_message_id: escalation.staff_message_id,
            created_at: escalation.created_at,
            inbound_text: staffMessage.inbound_text,
          })),
        },
        acknowledgement_status: 'accepted',
        acknowledgement_text: clarification,
        acknowledgement_transport_message_id: ack.messageId,
      });
    }
    const completed = await completeReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      outcome: 'clarification_sent', escalationId: null,
    });
    return {
      isOwner: true, handled: completed, route: 'owner_decision',
      reason: completed ? 'clarification_sent' : 'receipt_complete_failed',
    };
  }

  const escalation = match.escalation;
  const staffMessage = match.staffMessage || await fetchStaffMessage({
    supabaseUrl, serviceKey, userId: identity.userId, staffMessageId: escalation.staff_message_id,
  });
  const staffContextText =
    typeof staffMessage?.inbound_text === 'string' ? staffMessage.inbound_text.trim() : '';
  const effectiveReplyText = match.originalAnswer || msg.body;
  const instructionText = stripDecisionIdentifier(effectiveReplyText).trim().slice(0, 1000);
  if (!staffMessage || !staffContextText || !instructionText) {
    await failReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      error: 'invalid_escalation_context',
    });
    return { isOwner: true, handled: false, route: 'quoted_escalation', reason: 'invalid_context' };
  }
  if (containsAdditionalOwnerCommand(instructionText)) {
    const ack = durableInbound?.acknowledgement_status === 'accepted' &&
      durableInbound?.acknowledgement_text === QUOTED_COMPOUND_TEXT
      ? { ok: true, alreadyAccepted: true }
      : await sendOwnerAcknowledgement({
          phoneNumberId: effectiveMsg.phoneNumberId,
          to: identity.ownerPhone,
          text: QUOTED_COMPOUND_TEXT,
        });
    if (!ack.ok) {
      await failReceipt({
        supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
        error: ack.reason || 'owner_ack_failed',
      });
      return { isOwner: true, handled: false, route: 'quoted_escalation', reason: 'owner_ack_failed' };
    }
    if (!ack.alreadyAccepted) {
      await updateCommand(supabaseUrl, serviceKey, receipt.row, identity.userId, {
        execution_status: 'unsupported',
        execution_error: 'quoted_compound_command',
        acknowledgement_status: 'accepted',
        acknowledgement_text: QUOTED_COMPOUND_TEXT,
        acknowledgement_transport_message_id: ack.messageId,
      });
    }
    const completed = await completeReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      outcome: 'clarification_sent', escalationId: escalation.id,
    });
    return {
      isOwner: true,
      handled: completed,
      route: 'quoted_escalation',
      reason: completed ? 'compound_rejected' : 'receipt_complete_failed',
    };
  }

  if (escalation.status === 'delivered_to_staff' && !durableInbound?.staff_transport_message_id) {
    await updateCommand(supabaseUrl, serviceKey, receipt.row, identity.userId, {
      execution_status: 'completed',
      execution_result: {
        command_type: 'owner_decision',
        match_method: match.method,
        duplicate_resolution_ignored: true,
      },
    });
    const completed = await completeReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      outcome: 'resolved_escalation', escalationId: escalation.id,
    });
    return {
      isOwner: true, handled: completed, route: 'owner_decision',
      reason: completed ? 'already_resolved' : 'receipt_complete_failed',
    };
  }

  const normalized = normalizeOwnerDecisionReply(instructionText);

  let result;
  try {
    if (durableInbound?.staff_transport_message_id) {
      const reconciled = await callRpcSingle(
        supabaseUrl, serviceKey, 'reconcile_accepted_escalation_answer_delivery',
        {
          p_id: escalation.id,
          p_user_id: identity.userId,
          p_transport_message_id: durableInbound.staff_transport_message_id,
        },
      );
      result = reconciled.error
        ? {
            kind: 'success', status: 'sent_unconfirmed',
            ownerReplyText: escalation.owner_reply_text,
            transportMessageId: durableInbound.staff_transport_message_id,
          }
        : {
            kind: 'success', status: 'delivered',
            ownerReplyText: reconciled.data.owner_reply_text,
            transportMessageId: durableInbound.staff_transport_message_id,
          };
    } else {
      result = await resolveAndDeliverEscalationAnswer({
        supabaseUrl,
        serviceKey,
        userId: identity.userId,
        deepLinkToken: escalation.deep_link_token,
        escalation,
        staffMessage,
        staffContextText,
        decision: normalized.decision,
        instructionText: normalized.instructionText,
        replyChannel: 'whatsapp',
      });
    }
  } catch (error) {
    await failReceipt({ supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row, error });
    return {
      isOwner: true,
      handled: false,
      route: 'quoted_escalation',
      reason: 'staff_delivery_failed',
      staffDelivery: 'processing_error',
    };
  }

  if (result.kind !== 'success') {
    const persisted = result.kind !== 'rpc_error';
    const failureAcknowledgement = persisted
      ? DELIVERY_FAILED_TEXT
      : 'I could not save your answer, so I did not claim it was sent. Please reply to the same quoted message again.';
    const failureAck = durableInbound?.acknowledgement_status === 'accepted' &&
      durableInbound?.acknowledgement_text === failureAcknowledgement
      ? { ok: true, alreadyAccepted: true }
      : await sendOwnerAcknowledgement({
          phoneNumberId: effectiveMsg.phoneNumberId,
          to: identity.ownerPhone,
          text: failureAcknowledgement,
        });
    if (failureAck.ok && !failureAck.alreadyAccepted) {
      await updateCommand(supabaseUrl, serviceKey, receipt.row, identity.userId, {
        acknowledgement_status: 'accepted',
        acknowledgement_text: failureAcknowledgement,
        acknowledgement_transport_message_id: failureAck.messageId,
      }).catch(() => {});
    }
    await markRetryable({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      error: result.kind || 'staff_delivery_failed',
    });
    await failReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      error: result.kind || 'staff_delivery_failed',
    });
    return {
      isOwner: true,
      handled: false,
      route: 'quoted_escalation',
      reason: 'staff_delivery_failed',
      staffDelivery: result.kind,
    };
  }

  const staffName = staffMessage.staff_name || 'the staff member';
  const acknowledgement =
    result.status === 'saved_unreachable'
      ? `I saved your answer, but I couldn't reach ${staffName} on WhatsApp yet.`
      : result.status === 'in_progress'
        ? `Got it — your answer to ${staffName} is already being delivered.`
        : result.status === 'sent_unconfirmed'
          ? `I sent your answer to ${staffName}, but delivery recording is still being reconciled.`
          : `Got it — I sent your answer to ${staffName}.`;
  if (result.transportMessageId && durableInbound?.staff_transport_message_id !== result.transportMessageId) {
    durableInbound = await updateCommand(supabaseUrl, serviceKey, receipt.row, identity.userId, {
      staff_transport_message_id: result.transportMessageId,
      execution_status: result.status === 'sent_unconfirmed' ? 'failed' : 'action_created',
      execution_result: {
        command_type: 'owner_decision',
        match_method: match.method,
        normalized_decision: normalized.decision,
        exact_reply: instructionText,
        selector_text: match.originalAnswer ? msg.body.trim().slice(0, 1000) : null,
        staff_delivery: result.status,
      },
    });
  }
  const ack = durableInbound?.acknowledgement_status === 'accepted' &&
    durableInbound?.acknowledgement_text === acknowledgement
    ? { ok: true, alreadyAccepted: true }
    : await sendOwnerAcknowledgement({
        phoneNumberId: effectiveMsg.phoneNumberId,
        to: identity.ownerPhone,
        text: acknowledgement,
      });
  if (!ack.ok) {
    await markRetryable({ supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row, error: ack.reason });
    await failReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      error: ack.reason || 'owner_ack_failed',
    });
    return {
      isOwner: true,
      handled: false,
      route: 'quoted_escalation',
      reason: 'owner_ack_failed',
      staffDelivery: result.status,
    };
  }
  if (!ack.alreadyAccepted) {
    await updateCommand(supabaseUrl, serviceKey, receipt.row, identity.userId, {
      execution_status: 'completed',
      execution_result: {
        command_type: 'owner_decision',
        match_method: match.method,
        normalized_decision: normalized.decision,
        exact_reply: instructionText,
        selector_text: match.originalAnswer ? msg.body.trim().slice(0, 1000) : null,
      },
      acknowledgement_status: 'accepted',
      acknowledgement_text: acknowledgement,
      acknowledgement_transport_message_id: ack.messageId,
      staff_transport_message_id: result.transportMessageId || null,
    });
  }
  if (result.status === 'sent_unconfirmed') {
    await markRetryable({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      error: 'staff_delivery_completion_unconfirmed',
    });
    await failReceipt({
      supabaseUrl, serviceKey, userId: identity.userId, receipt: receipt.row,
      error: 'staff_delivery_completion_unconfirmed',
    });
    return {
      isOwner: true,
      handled: false,
      route: 'quoted_escalation',
      reason: 'staff_delivery_completion_unconfirmed',
      staffDelivery: result.status,
    };
  }

  const completed = await completeReceipt({
    supabaseUrl,
    serviceKey,
    userId: identity.userId,
    receipt: receipt.row,
    outcome: 'resolved_escalation',
    escalationId: escalation.id,
  });
  if (completed && match.clarificationReceiptId) {
    await markDisambiguationResolved({
      supabaseUrl,
      serviceKey,
      userId: identity.userId,
      clarificationReceiptId: match.clarificationReceiptId,
      selectorReceiptId: receipt.row.receipt_id,
      escalationId: escalation.id,
    }).catch(() => {});
  }
  return {
    isOwner: true,
    handled: completed,
    route: 'quoted_escalation',
    reason: completed ? 'resolved_escalation' : 'receipt_complete_failed',
    staffDelivery: result.status,
  };
}

async function matchPendingDisambiguation({
  supabaseUrl, serviceKey, userId, selectorText, selectorReceiptId,
}) {
  const rows = await restSelect(
    supabaseUrl,
    serviceKey,
    'owner_whatsapp_reply_receipts',
    `user_id=eq.${encodeURIComponent(userId)}&outcome=eq.clarification_sent` +
      '&execution_result->>match_method=eq.ambiguous' +
      '&select=id,created_at,execution_result&order=created_at.desc&limit=1',
  );
  const pending = rows[0];
  if (!pending?.execution_result) return null;
  const state = pending.execution_result;
  if (state.clarification_status === 'resolved') {
    return { kind: 'disambiguation_already_resolved', clarificationReceiptId: pending.id };
  }
  if (state.clarification_status === 'claimed' &&
      state.selector_receipt_id !== selectorReceiptId) {
    return { kind: 'disambiguation_in_progress', clarificationReceiptId: pending.id };
  }
  if (!['pending', 'claimed'].includes(state.clarification_status)) return null;
  const expiresAt = Date.parse(state.expires_at || pending.created_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { kind: 'disambiguation_expired', clarificationReceiptId: pending.id };
  }
  const candidates = Array.isArray(state.candidates) ? state.candidates : [];
  const selected = selectDisambiguationCandidate(selectorText, candidates);
  if (!selected) {
    return { kind: 'disambiguation_ambiguous', clarificationReceiptId: pending.id };
  }
  const claimed = state.clarification_status === 'claimed'
    ? state.selector_receipt_id === selectorReceiptId
    : await claimDisambiguation({
        supabaseUrl, serviceKey, userId, pending, selectorReceiptId,
      });
  if (!claimed) return { kind: 'disambiguation_ambiguous', clarificationReceiptId: pending.id };
  const escalationRows = await restSelect(
    supabaseUrl,
    serviceKey,
    'staff_escalation_owner_decisions',
    `id=eq.${encodeURIComponent(selected.decision_id)}&user_id=eq.${encodeURIComponent(userId)}` +
      '&select=id,user_id,staff_message_id,status,owner_reply_text,deep_link_token,created_at&limit=1',
  );
  if (escalationRows.length !== 1) {
    await releaseDisambiguation({
      supabaseUrl, serviceKey, userId, pending, selectorReceiptId,
    });
    return { kind: 'disambiguation_context_unavailable', clarificationReceiptId: pending.id };
  }
  if (escalationRows[0].status !== 'open') {
    await markDisambiguationResolved({
      supabaseUrl,
      serviceKey,
      userId,
      clarificationReceiptId: pending.id,
      selectorReceiptId,
      escalationId: escalationRows[0].id,
    });
    return { kind: 'disambiguation_already_resolved', clarificationReceiptId: pending.id };
  }
  const staffMessage = await fetchStaffMessage({
    supabaseUrl,
    serviceKey,
    userId,
    staffMessageId: escalationRows[0].staff_message_id,
    requireOwnerNotification: true,
  });
  if (!staffMessage) {
    await releaseDisambiguation({
      supabaseUrl, serviceKey, userId, pending, selectorReceiptId,
    });
    return { kind: 'disambiguation_context_unavailable', clarificationReceiptId: pending.id };
  }
  return {
    kind: 'matched',
    method: 'clarification_selector',
    escalation: escalationRows[0],
    staffMessage,
    originalAnswer: String(state.original_answer || '').trim(),
    clarificationReceiptId: pending.id,
  };
}

export function selectDisambiguationCandidate(selectorText, candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2) return null;
  const value = String(selectorText || '').toLowerCase().replace(/[.!?]+$/g, '').trim();
  if (/^(?:the\s+)?first(?:\s+one)?$/.test(value)) return candidates[0];
  if (/^(?:the\s+)?second(?:\s+one)?$/.test(value)) return candidates[1];
  if (/^(?:the\s+)?latest(?:\s+one)?$/.test(value)) {
    return [...candidates].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  }
  if (/^(?:the\s+)?earlier(?:\s+one)?$/.test(value)) {
    return [...candidates].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
  }
  const clock = value.match(/\b(?:the\s+one\s+from\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (clock) {
    const target = `${clock[1].padStart(2, '0')}:${clock[2]}`;
    const matches = candidates.filter((candidate) => new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(candidate.created_at)) === target);
    return matches.length === 1 ? matches[0] : null;
  }
  const terms = value
    .replace(/\b(?:the|one|request|decision|from)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((term) => term.length >= 4);
  if (!terms.length) return null;
  const matches = candidates.filter((candidate) => {
    const source = String(candidate.inbound_text || '').toLowerCase();
    return terms.every((term) => source.includes(term));
  });
  return matches.length === 1 ? matches[0] : null;
}

export function isDisambiguationSelectorMessage(text) {
  const value = String(text || '').toLowerCase().replace(/[.!?]+$/g, '').trim();
  return /^(?:the\s+)?(?:first|second|latest|earlier)(?:\s+one)?$/.test(value) ||
    /^(?:the\s+)?one\s+from\s+(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value) ||
    /^(?:the\s+)?[a-z0-9][a-z0-9 -]{1,80}\s+one$/.test(value);
}

async function claimDisambiguation({
  supabaseUrl, serviceKey, userId, pending, selectorReceiptId,
}) {
  const nextState = {
    ...pending.execution_result,
    clarification_status: 'claimed',
    selector_receipt_id: selectorReceiptId,
  };
  const rows = await restPatch(
    supabaseUrl,
    serviceKey,
    'owner_whatsapp_reply_receipts',
    `id=eq.${encodeURIComponent(pending.id)}&user_id=eq.${encodeURIComponent(userId)}` +
      '&execution_result->>clarification_status=eq.pending',
    { execution_result: nextState },
  );
  return rows.length === 1;
}

async function markDisambiguationResolved({
  supabaseUrl, serviceKey, userId, clarificationReceiptId, selectorReceiptId, escalationId,
}) {
  const rows = await restSelect(
    supabaseUrl, serviceKey, 'owner_whatsapp_reply_receipts',
    `id=eq.${encodeURIComponent(clarificationReceiptId)}&user_id=eq.${encodeURIComponent(userId)}` +
      '&select=execution_result&limit=1',
  );
  if (rows.length !== 1) return false;
  const state = rows[0].execution_result || {};
  const updated = await restPatch(
    supabaseUrl,
    serviceKey,
    'owner_whatsapp_reply_receipts',
    `id=eq.${encodeURIComponent(clarificationReceiptId)}&user_id=eq.${encodeURIComponent(userId)}` +
      `&execution_result->>selector_receipt_id=eq.${encodeURIComponent(selectorReceiptId)}`,
    {
      execution_result: {
        ...state,
        clarification_status: 'resolved',
        selected_decision_id: escalationId,
        resolved_at: new Date().toISOString(),
      },
    },
  );
  return updated.length === 1;
}

async function releaseDisambiguation({
  supabaseUrl, serviceKey, userId, pending, selectorReceiptId,
}) {
  const { selector_receipt_id: _discard, ...state } = pending.execution_result || {};
  const updated = await restPatch(
    supabaseUrl,
    serviceKey,
    'owner_whatsapp_reply_receipts',
    `id=eq.${encodeURIComponent(pending.id)}&user_id=eq.${encodeURIComponent(userId)}` +
      `&execution_result->>selector_receipt_id=eq.${encodeURIComponent(selectorReceiptId)}`,
    { execution_result: { ...state, clarification_status: 'pending' } },
  );
  return updated.length === 1;
}

export function containsAdditionalOwnerCommand(text) {
  return /\b(?:and|also|then)\s+(?:(?:tell|ask)\s+[A-Za-z][A-Za-z'’-]*|remind\s+me)\b/i.test(
    String(text || ''),
  );
}

export function normalizeOwnerDecisionReply(text) {
  const exact = String(text || '').trim().slice(0, 1000);
  const normalized = exact.toLowerCase().replace(/[.!?]+$/g, '').trim();
  if (/^(?:yes|approve(?: it)?|approved)$/.test(normalized)) {
    return { decision: 'approved', instructionText: null };
  }
  if (/^(?:no|do not approve(?: it)?|don't approve(?: it)?|dont approve(?: it)?|rejected?)$/.test(normalized)) {
    return { decision: 'rejected', instructionText: null };
  }
  return { decision: 'custom_instruction', instructionText: exact };
}

export function isDecisionShapedMessage(text) {
  const value = String(text || '').trim();
  return /^(?:yes\b|no\b|approve\b|approved\b|do not approve\b|don't approve\b|dont approve\b|buy\b|use\b|do not\b|don't\b|ask\s+christopher\b)/i.test(value);
}

async function matchOwnerDecision({ supabaseUrl, serviceKey, userId, msg }) {
  if (msg.contextMessageId) {
    const escalation = await findQuotedEscalation({
      supabaseUrl, serviceKey, userId, contextMessageId: msg.contextMessageId,
    });
    return escalation
      ? { kind: 'matched', method: 'quoted_message', escalation }
      : { kind: 'unmatched_quote' };
  }

  const explicitId = extractDecisionIdentifier(msg.body);
  if (explicitId) {
    const rows = await restSelect(
      supabaseUrl,
      serviceKey,
      'staff_escalation_owner_decisions',
      `user_id=eq.${encodeURIComponent(userId)}` +
        `&or=(id.eq.${encodeURIComponent(explicitId)},deep_link_token.eq.${encodeURIComponent(explicitId)})` +
        '&select=id,user_id,staff_message_id,status,owner_reply_text,deep_link_token&limit=2',
    );
    return rows.length === 1
      ? { kind: 'matched', method: 'explicit_identifier', escalation: rows[0] }
      : { kind: 'unmatched_identifier' };
  }

  if (!isDecisionShapedMessage(msg.body)) return { kind: 'general' };
  const since = new Date(Date.now() - DECISION_LOOKBACK_DAYS * 86_400_000).toISOString();
  const decisions = await restSelect(
    supabaseUrl,
    serviceKey,
    'staff_escalation_owner_decisions',
    `user_id=eq.${encodeURIComponent(userId)}&status=eq.open&created_at=gte.${encodeURIComponent(since)}` +
      '&select=id,user_id,staff_message_id,status,owner_reply_text,deep_link_token,created_at' +
      '&order=created_at.desc&limit=3',
  );
  const matches = [];
  for (const escalation of decisions) {
    const staffMessage = await fetchStaffMessage({
      supabaseUrl, serviceKey, userId, staffMessageId: escalation.staff_message_id,
      requireOwnerNotification: true,
    });
    if (staffMessage) matches.push({ escalation, staffMessage });
  }
  if (matches.length === 1) {
    return { kind: 'matched', method: 'single_recent_unresolved', ...matches[0] };
  }
  return matches.length > 1 ? { kind: 'ambiguous', matches } : { kind: 'general' };
}

function extractDecisionIdentifier(text) {
  return String(text || '').match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  )?.[0] || null;
}

function stripDecisionIdentifier(text) {
  return String(text || '')
    .replace(/\bdecision\s+[0-9a-f-]{36}\s*:?\s*/i, '')
    .trim();
}

function buildAmbiguityText(matches) {
  const firstTwo = matches.slice(0, 2);
  const staffNames = [...new Set(firstTwo.map(({ staffMessage }) => staffMessage.staff_name).filter(Boolean))];
  const staff = staffNames.length === 1 ? staffNames[0] : 'your staff';
  const topics = firstTwo.map(({ staffMessage }) => summarizeDecisionTopic(staffMessage.inbound_text));
  return `I have two pending decisions from ${staff}. Which one do you mean, ${topics[0]} or ${topics[1]}?`;
}

function summarizeDecisionTopic(text) {
  const value = String(text || '').toLowerCase();
  if (value.includes('dessert') && value.includes('plate')) return 'the dessert plate';
  if (value.includes('vinegar')) return 'the vinegar purchase';
  const concise = String(text || '').replace(/[?!.]+$/g, '').trim().slice(0, 60);
  return `the “${concise}” request`;
}

export async function resolveCanonicalOwner({ supabaseUrl, serviceKey, msg }) {
  const accounts = await restSelect(
    supabaseUrl,
    serviceKey,
    'whatsapp_health_state',
    `phone_number_id=eq.${encodeURIComponent(msg.phoneNumberId)}&select=user_id`,
  );
  const userIds = [...new Set(accounts.map((row) => row.user_id).filter(Boolean))];
  if (userIds.length !== 1) {
    return { isOwner: false, routingEnabled: false, reason: 'account_not_unique' };
  }
  const userId = userIds[0];
  if (!isOwnerRoutingEnabledForUser(userId)) {
    return { isOwner: false, routingEnabled: false, userId, reason: 'routing_disabled' };
  }
  const people = await restSelect(
    supabaseUrl,
    serviceKey,
    'people',
    `user_id=eq.${encodeURIComponent(userId)}&select=id,name,role,phone`,
  );
  const ownerCandidates = people.filter((person) => {
    const name = String(person.name || '').trim().toLowerCase();
    const role = String(person.role || '').trim().toLowerCase();
    return (name === 'boss' || role === 'boss') && normalizePhone(person.phone);
  });
  const sender = normalizePhone(msg.from);
  if (ownerCandidates.length !== 1) {
    const exactPeople = people.filter((person) => normalizePhone(person.phone) === sender);
    const definitelyStaff = exactPeople.length === 1 && !ownerCandidates.includes(exactPeople[0]);
    return definitelyStaff
      ? { isOwner: false, routingEnabled: true, userId, reason: 'definitely_not_owner' }
      : { isOwner: false, possibleOwner: true, routingEnabled: true, userId, reason: 'canonical_owner_not_unique' };
  }
  const ownerPhone = normalizePhone(ownerCandidates[0].phone);
  if (!sender || sender !== ownerPhone) {
    return { isOwner: false, routingEnabled: true, userId, reason: 'not_owner' };
  }
  return { isOwner: true, routingEnabled: true, userId, ownerPhone };
}

export function isOwnerRoutingEnabledForUser(userId) {
  const enabled = String(process.env.OWNER_WHATSAPP_ROUTING_USER_IDS || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  return Boolean(userId) && enabled.includes(userId);
}

export async function reconcileOwnerWhatsappMessages({ supabaseUrl, serviceKey, limit = 20 }) {
  let rows;
  try {
    rows = await restSelect(
      supabaseUrl,
      serviceKey,
      'owner_whatsapp_reply_receipts',
      `status=eq.failed&next_retry_at=lte.${encodeURIComponent(new Date().toISOString())}` +
        '&execution_status=neq.terminal_failed' +
        `&retry_count=lt.5&select=user_id,external_message_id,inbound_text,sender_phone,phone_number_id,context_message_id&limit=${limit}`,
    );
  } catch {
    // Migration may deliberately be absent while the default-off code is
    // deployed. Reconciliation is fail-isolated from the existing cron work.
    return [];
  }
  const results = [];
  for (const row of rows) {
    if (!isOwnerRoutingEnabledForUser(row.user_id) || !row.inbound_text) continue;
    const result = await handleInboundOwnerMessage({
      supabaseUrl,
      serviceKey,
      msg: {
        messageId: row.external_message_id,
        from: row.sender_phone,
        body: row.inbound_text,
        phoneNumberId: row.phone_number_id,
        contextMessageId: row.context_message_id || null,
      },
    });
    results.push(result);
  }
  return results;
}

async function markRetryable({ supabaseUrl, serviceKey, userId, receipt, error }) {
  await updateCommand(supabaseUrl, serviceKey, receipt, userId, {
    execution_status: 'failed',
    execution_error: String(error || 'processing_failed'),
    next_retry_at: new Date(Date.now() + 60_000).toISOString(),
  }).catch(() => {});
}

async function findQuotedEscalation({ supabaseUrl, serviceKey, userId, contextMessageId }) {
  const deliveries = await restSelect(
    supabaseUrl,
    serviceKey,
    'whatsapp_deliveries',
    `user_id=eq.${encodeURIComponent(userId)}&meta_message_id=eq.${encodeURIComponent(contextMessageId)}` +
      '&recipient_name=eq.Owner&select=metadata&limit=2',
  );
  if (deliveries.length !== 1) return null;
  const escalationId = deliveries[0]?.metadata?.escalation_id;
  if (!escalationId) return null;
  const escalations = await restSelect(
    supabaseUrl,
    serviceKey,
    'staff_escalation_owner_decisions',
    `id=eq.${encodeURIComponent(escalationId)}&user_id=eq.${encodeURIComponent(userId)}` +
      '&select=id,user_id,staff_message_id,status,owner_reply_text,deep_link_token&limit=2',
  );
  return escalations.length === 1 ? escalations[0] : null;
}

async function fetchStaffMessage({
  supabaseUrl, serviceKey, userId, staffMessageId, requireOwnerNotification = false,
}) {
  const rows = await restSelect(
    supabaseUrl,
    serviceKey,
    'staff_messages',
    `id=eq.${encodeURIComponent(staffMessageId)}&user_id=eq.${encodeURIComponent(userId)}` +
      '&select=id,user_id,person_id,staff_name,staff_phone,inbound_text,owner_notification_status&limit=2',
  );
  if (rows.length !== 1) return null;
  if (requireOwnerNotification && rows[0].owner_notification_status !== 'sent') return null;
  return rows[0];
}

async function claimReceipt({ supabaseUrl, serviceKey, userId, externalMessageId }) {
  try {
    const result = await callRpcRows(supabaseUrl, serviceKey, 'claim_owner_whatsapp_reply', {
      p_user_id: userId,
      p_external_message_id: externalMessageId,
      p_lease_seconds: RECEIPT_LEASE_SECONDS,
    });
    if (result.error || !result.data?.[0]) {
      return { ok: false, reason: result.error?.message || 'receipt_claim_failed' };
    }
    return { ok: true, row: result.data[0] };
  } catch (error) {
    return { ok: false, reason: error?.message || 'receipt_claim_failed' };
  }
}

async function completeReceipt({ supabaseUrl, serviceKey, userId, receipt, outcome, escalationId }) {
  try {
    const result = await callRpcSingle(supabaseUrl, serviceKey, 'complete_owner_whatsapp_reply', {
      p_id: receipt.receipt_id,
      p_user_id: userId,
      p_claim_token: receipt.claim_token,
      p_outcome: outcome,
      p_escalation_id: escalationId,
    });
    if (!result.error) return true;
    await failReceipt({ supabaseUrl, serviceKey, userId, receipt, error: result.error.message });
    return false;
  } catch (error) {
    await failReceipt({ supabaseUrl, serviceKey, userId, receipt, error });
    return false;
  }
}

async function failReceipt({ supabaseUrl, serviceKey, userId, receipt, error }) {
  try {
    await callRpcSingle(supabaseUrl, serviceKey, 'fail_owner_whatsapp_reply', {
      p_id: receipt.receipt_id,
      p_user_id: userId,
      p_claim_token: receipt.claim_token,
      p_error: String(error?.message || error || 'processing_failed'),
    });
  } catch {
    // The original failure remains the actionable error; stale-token failure
    // here must not trigger a second side effect.
  }
}

async function sendOwnerAcknowledgement({ phoneNumberId, to, text }) {
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
    return result.ok
      ? { ok: true, messageId: result.messageId }
      : { ok: false, reason: result.error || 'meta_rejected' };
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

async function restPatch(url, key, table, query, body) {
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${table}_update_failed`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}
