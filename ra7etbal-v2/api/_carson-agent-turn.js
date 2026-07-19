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

// Leaves headroom under the function's 60s maxDuration for the surrounding
// webhook logic (delivery-status/consent handling, logging) to still run.
const TURN_TIMEOUT_MS = 45000;

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
    const agentText = await runCarsonTurn({ apiKey, agentId, staffText: body });
    console.log('Carson bridge PoC: turn complete', {
      messageId,
      personRole:      person.role || null,
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
function runCarsonTurn({ apiKey, agentId, staffText }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    let deadline;

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

        try {
          socket = new WebSocket(signedUrl);
        } catch (err) {
          finish(reject, err);
          return;
        }

        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({
            type: 'conversation_initiation_client_data',
            conversation_config_override: {
              conversation: { text_only: true },
              agent:        { prompt: { tool_ids: [] } },
            },
          }));
        });

        socket.addEventListener('message', (event) => {
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          handleServerEvent(payload, { socket, staffText, finish, resolve });
        });

        socket.addEventListener('error', () => {
          finish(reject, new Error('carson_turn_socket_error'));
        });

        // event.code/event.reason are the WebSocket close frame's code and
        // UTF-8 reason text (never message content or secrets) — logging
        // them is what tells us *why* the server closed the connection.
        socket.addEventListener('close', (event) => {
          const code = event?.code ?? null;
          const reason = event?.reason ? String(event.reason).slice(0, 200) : null;
          finish(reject, new Error(`carson_turn_closed_before_response code=${code} reason=${reason || 'none'}`));
        });
      })
      .catch((err) => finish(reject, err));
  });
}

function handleServerEvent(payload, { socket, staffText, finish, resolve }) {
  const type = payload?.type;

  switch (type) {
    case 'ping': {
      const eventId = payload.ping_event?.event_id ?? payload.event_id;
      socket.send(JSON.stringify({ type: 'pong', event_id: eventId }));
      break;
    }

    case 'conversation_initiation_metadata': {
      // Exactly one client message follows metadata: user_message. An
      // earlier version also sent a contextual_update note here — two
      // client messages in immediate succession at this point in the turn
      // is the most likely reason production saw a normal (code 1000)
      // server-initiated close before any response: this was the one
      // deviation from the verified protocol sequence.
      socket.send(JSON.stringify({ type: 'user_message', text: staffText }));
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
