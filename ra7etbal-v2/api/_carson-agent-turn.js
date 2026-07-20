/**
 * Staff -> Carson WhatsApp bridge — READ-ONLY proof of concept.
 *
 * Underscore-prefixed: Vercel does not deploy this as a Function (same
 * convention as _quality-review.js / _whatsapp-delivery.js), so it does not
 * count against the Hobby 12-function cap.
 *
 * Scope: identify a known, opted-in, non-family staff sender from an inbound
 * WhatsApp message already parsed by whatsapp-webhook.js, open one text-only
 * turn with the existing production ElevenLabs Carson agent, capture the
 * response, and log a safe summary. This slice never sends a WhatsApp reply
 * and never writes to Supabase — it exists to validate the ElevenLabs bridge
 * itself before any task-mutation logic is built on top of it.
 */

const SIGNED_URL_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url';
const CONVERSATION_DETAILS_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/conversations';

// Leaves headroom under the function's 60s maxDuration for the surrounding
// webhook logic (delivery-status/consent handling, logging) to still run.
const TURN_TIMEOUT_MS = 45000;

// Diagnostic-only lookup, run after a premature close. Small, strict bound:
// the first attempt plus up to two retries (three total) if the API reports
// the conversation is still "processing", with a short pause between tries.
const DETAILS_MAX_ATTEMPTS = 3;
const DETAILS_RETRY_DELAY_MS = 300;

// Best-effort, in-process idempotency only — bounded to the current warm
// container, not durable across cold starts or concurrent instances. This
// slice makes no Supabase writes, so a durable dedupe table is deferred to
// the slice that actually mutates data.
const processedMessageIds = new Set();
const MAX_TRACKED_IDS = 500;

function rememberMessageId(messageId) {
  if (processedMessageIds.size >= MAX_TRACKED_IDS) {
    const oldest = processedMessageIds.values().next().value;
    processedMessageIds.delete(oldest);
  }
  processedMessageIds.add(messageId);
}

/**
 * @param {object} params
 * @param {string} params.supabaseUrl
 * @param {string} params.serviceKey
 * @param {{ from: string, messageId: string, body: string, timestamp?: string }} params.msg
 * @param {(args: { supabaseUrl: string, serviceKey: string, rawPhone: string }) => Promise<object|null>} params.findPersonByPhone
 *   Injected rather than imported directly, so this module never needs to
 *   import back from whatsapp-webhook.js and stays independently testable.
 */
export async function attemptCarsonBridgePoc({ supabaseUrl, serviceKey, msg, findPersonByPhone }) {
  const { from, body, messageId } = msg;

  if (!messageId) {
    console.warn('Carson bridge PoC: inbound message missing id, skipping');
    return { handled: false, reason: 'missing_message_id' };
  }

  // Claim the id synchronously (no await before this point) so two
  // near-simultaneous retries within the same warm instance can't both pass
  // the check before either marks it.
  if (processedMessageIds.has(messageId)) {
    console.log('Carson bridge PoC: duplicate message id, skipping', { messageId });
    return { handled: false, reason: 'duplicate_message_id', messageId };
  }
  rememberMessageId(messageId);

  const apiKey  = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.VITE_ELEVENLABS_AGENT_ID;
  if (!apiKey || !agentId) {
    console.error('Carson bridge PoC: missing ElevenLabs configuration', {
      hasApiKey: Boolean(apiKey),
      hasAgentId: Boolean(agentId),
    });
    return { handled: false, reason: 'missing_config', messageId };
  }

  const person = await findPersonByPhone({ supabaseUrl, serviceKey, rawPhone: from });
  if (!person) {
    console.log('Carson bridge PoC: unknown sender, ignoring', { messageId });
    return { handled: false, reason: 'unknown_sender', messageId };
  }
  if (person.is_family) {
    console.log('Carson bridge PoC: family number, ignoring', { messageId });
    return { handled: false, reason: 'rejected_family', messageId };
  }
  if (!person.whatsapp_opted_in) {
    console.log('Carson bridge PoC: sender not opted in, ignoring', { messageId });
    return { handled: false, reason: 'rejected_unconsented', messageId };
  }

  const startedAt = Date.now();
  try {
    const agentText = await runCarsonTurn({ apiKey, agentId, staffText: body, messageId });
    console.log('Carson bridge PoC: turn complete', {
      messageId,
      responseReceived: agentText != null,
      responseLength:   agentText ? agentText.length : 0,
      elapsedMs:        Date.now() - startedAt,
    });
    return { handled: true, reason: 'answered', messageId };
  } catch (err) {
    console.error('Carson bridge PoC: turn failed', {
      messageId,
      elapsedMs: Date.now() - startedAt,
      error:     err?.message || 'unknown_error',
    });
    return { handled: false, reason: 'error', messageId };
  }
}

async function getSignedUrl({ apiKey, agentId }) {
  const response = await fetch(
    `${SIGNED_URL_ENDPOINT}?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { 'xi-api-key': apiKey } },
  );
  if (!response.ok) {
    throw new Error(`get-signed-url failed with status ${response.status}`);
  }
  const data = await response.json().catch(() => null);
  if (!data?.signed_url) {
    throw new Error('get-signed-url response missing signed_url');
  }
  return data.signed_url;
}

/**
 * Diagnostic-only: after a premature close, ask ElevenLabs' own Conversation
 * Details API why. Never throws — any failure here is logged as a safe
 * classification and swallowed, since this must never affect the turn's own
 * failure outcome. Retries briefly, within a strict small bound, only while
 * the API reports the conversation is still "processing".
 */
async function fetchConversationDetailsSafely({ apiKey, conversationId, messageId }) {
  for (let attempt = 1; attempt <= DETAILS_MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(
        `${CONVERSATION_DETAILS_ENDPOINT}/${encodeURIComponent(conversationId)}`,
        { headers: { 'xi-api-key': apiKey } },
      );
    } catch {
      console.log('Carson bridge PoC: conversation details lookup errored', { messageId, attempt });
      return;
    }

    if (!response.ok) {
      console.log('Carson bridge PoC: conversation details lookup failed', {
        messageId,
        attempt,
        httpStatus: response.status,
      });
      return;
    }

    const data = await response.json().catch(() => null);
    if (!data) {
      console.log('Carson bridge PoC: conversation details lookup returned no data', { messageId, attempt });
      return;
    }

    if (data.status === 'processing' && attempt < DETAILS_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, DETAILS_RETRY_DELAY_MS));
      continue;
    }

    logSafeConversationDetails({ messageId, data });
    return;
  }
}

/**
 * Logs only structural/classification fields confirmed present in
 * ElevenLabs' documented Conversation Details response — never transcript
 * text, phone numbers, person data, prompts, dynamic-variable values,
 * credentials, or the full response object.
 */
function logSafeConversationDetails({ messageId, data }) {
  const transcript = Array.isArray(data.transcript) ? data.transcript : [];
  const userTranscriptEntries = transcript.filter((entry) => entry?.role === 'user').length;
  const agentTranscriptEntries = transcript.filter((entry) => entry?.role === 'agent').length;
  const terminationReason = data.metadata?.termination_reason
    ? String(data.metadata.termination_reason).slice(0, 200)
    : null;

  console.log('Carson bridge PoC: conversation details', {
    messageId,
    conversationId: data.conversation_id || null,
    status: data.status || null,
    terminationReason,
    hasUserTranscript: userTranscriptEntries > 0,
    hasAgentTranscript: agentTranscriptEntries > 0,
    userTranscriptEntries,
    agentTranscriptEntries,
    textOnly: typeof data.metadata?.text_only === 'boolean' ? data.metadata.text_only : null,
    authorizationMethod: data.metadata?.authorization_method || null,
    versionId: data.version_id || null,
    branchId: data.branch_id || null,
    hasError: Boolean(data.metadata?.error),
  });
}

/**
 * Drives exactly one text-only Carson turn over the ElevenLabs Conversational
 * AI WebSocket and resolves with the agent's final text response.
 *
 * Defensive event-field extraction: ElevenLabs nests event-specific payloads
 * under a key named after the event type (e.g. `ping_event`, `agent_response_event`),
 * but the exact shape was inferred from documentation, not a live-verified
 * schema — this is exactly what this proof of concept exists to confirm. Each
 * extraction below tries the nested shape first and falls back to a flat one
 * rather than throwing on a shape mismatch.
 */
function runCarsonTurn({ apiKey, agentId, staffText, messageId }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    let deadline;
    // Tracks the last confirmed step of the turn and whether the first
    // server event after user_message has been logged yet. Read on close
    // to identify exactly how far the turn got — messageId/type/step are
    // the only diagnostic fields logged; never message content, phone,
    // person data, prompts, tokens, credentials, or full payloads.
    const diag = { lastStep: 'signed_url_requested', firstPostUserMessageEventLogged: false, conversationId: null };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { socket?.close?.(); } catch { /* ignore */ }
      fn(value);
    };

    deadline = setTimeout(() => {
      finish(reject, new Error('carson_turn_timeout'));
    }, TURN_TIMEOUT_MS);

    getSignedUrl({ apiKey, agentId })
      .then((signedUrl) => {
        if (settled) return;
        diag.lastStep = 'signed_url_received';

        try {
          socket = new WebSocket(signedUrl);
        } catch (err) {
          finish(reject, err);
          return;
        }

        socket.addEventListener('open', () => {
          console.log('Carson bridge PoC: WS opened', { messageId });
          diag.lastStep = 'ws_opened';

          socket.send(JSON.stringify({
            type: 'conversation_initiation_client_data',
            conversation_config_override: {
              conversation: { text_only: true },
              agent:        { prompt: { tool_ids: [] } },
            },
          }));
          console.log('Carson bridge PoC: conversation_initiation_client_data sent', { messageId });
          diag.lastStep = 'init_data_sent';
        });

        socket.addEventListener('message', (event) => {
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }

          if (diag.lastStep === 'user_message_sent' && !diag.firstPostUserMessageEventLogged) {
            diag.firstPostUserMessageEventLogged = true;
            console.log('Carson bridge PoC: first event after user_message', {
              messageId,
              type: payload?.type || null,
            });
          }

          handleServerEvent(payload, { socket, staffText, finish, resolve, messageId, diag });
        });

        socket.addEventListener('error', () => {
          finish(reject, new Error('carson_turn_socket_error'));
        });

        // event.reason is untrusted, server-provided text — never logged or
        // embedded in the diagnostic error, only whether one was present.
        // event.code and the last confirmed step are what tell us *why* and
        // *where* the server closed the connection.
        socket.addEventListener('close', (event) => {
          // A close fired after we already succeeded is just our own
          // post-resolve cleanup (finish() calls socket.close()) — nothing
          // to diagnose, and no conversation-details call to make.
          if (settled) return;

          const code = event?.code ?? null;
          const hasReason = Boolean(event?.reason);
          console.log('Carson bridge PoC: WS closed', {
            messageId,
            code,
            hasReason,
            lastStep: diag.lastStep,
          });

          const conversationId = diag.conversationId;
          const lookup = conversationId
            ? fetchConversationDetailsSafely({ apiKey, conversationId, messageId }).catch(() => {})
            : Promise.resolve();

          lookup.finally(() => {
            finish(reject, new Error(`carson_turn_closed_before_response code=${code} hasReason=${hasReason} lastStep=${diag.lastStep}`));
          });
        });
      })
      .catch((err) => finish(reject, err));
  });
}

function handleServerEvent(payload, { socket, staffText, finish, resolve, messageId, diag }) {
  const type = payload?.type;

  switch (type) {
    case 'ping': {
      const eventId = payload.ping_event?.event_id ?? payload.event_id;
      socket.send(JSON.stringify({ type: 'pong', event_id: eventId }));
      break;
    }

    case 'conversation_initiation_metadata': {
      diag.conversationId = payload.conversation_initiation_metadata_event?.conversation_id ?? null;
      console.log('Carson bridge PoC: conversation_initiation_metadata received', { messageId });
      diag.lastStep = 'metadata_received';

      // Exactly one client message follows metadata: user_message. An
      // earlier version also sent a contextual_update note here — two
      // client messages in immediate succession at this point in the turn
      // was the most likely reason production saw a normal (code 1000)
      // server-initiated close before any response — that was fixed, but
      // production is still closing at code 1000 after this point, hence
      // the step-by-step logging added here.
      socket.send(JSON.stringify({ type: 'user_message', text: staffText }));
      console.log('Carson bridge PoC: user_message sent', { messageId });
      diag.lastStep = 'user_message_sent';
      break;
    }

    case 'client_tool_call': {
      // This is a server-side, browser-less turn — no client tools are
      // connected. Reply with an error result so Carson recovers instead of
      // the turn stalling on a client_tool_call no one will ever answer.
      const toolCallId = payload.client_tool_call?.tool_call_id ?? payload.tool_call_id;
      socket.send(JSON.stringify({
        type:        'client_tool_result',
        tool_call_id: toolCallId,
        result:      'Client tools are not available in this channel.',
        is_error:    true,
        error_type:  'external_client',
      }));
      break;
    }

    case 'agent_response': {
      const text = payload.agent_response_event?.agent_response ?? payload.agent_response ?? payload.text ?? null;
      finish(resolve, text);
      break;
    }

    default:
      // Unrecognized event during the PoC — log structure only (never
      // content) so a real test run can confirm/correct the assumed shapes
      // above without ever putting staff message content in logs.
      if (type) {
        console.log('Carson bridge PoC: unhandled WS event type', { type });
      }
      break;
  }
}
