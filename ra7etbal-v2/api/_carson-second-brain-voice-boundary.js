/**
 * carson-second-brain-voice-boundary.js
 *
 * Second Brain Slice 2 — the Custom LLM transport boundary that lets
 * ElevenLabs' voice agent consume the SAME grounded reasoning that already
 * powers typed Carson (api/carson-turn.js's coordinateAttention/
 * coordinateCalendar), instead of ElevenLabs' own hosted model
 * independently narrating operational truth.
 *
 * Fresh implementation, not a revival of the parked Stage2A/C-03 branch.
 * The only ideas carried forward from that investigation (explicitly as
 * lessons, not code): (1) ElevenLabs' dashboard "Request headers" are
 * static/agent-wide, so a per-conversation owner identity can only be
 * delivered via the SDK's own customLlmExtraBody at startSession time,
 * relayed by ElevenLabs as `elevenlabs_extra_body`; (2) provider
 * authentication (proves the caller is our configured ElevenLabs agent)
 * and owner-binding authentication (proves which authenticated Ra7etBal
 * owner this conversation belongs to) are two independent controls, both
 * required, neither substitutes for the other.
 *
 * Two exported pieces:
 *   - Owner binding: createSessionBinding/verifySessionBinding, a
 *     short-lived, HMAC-signed, single-purpose token — NOT a JWT, carries
 *     no scopes beyond "this account may use the voice boundary for the
 *     next few minutes." Issuing one still requires the owner's real
 *     Supabase session (authenticateOwner).
 *   - Provider authentication + OpenAI-wire-protocol SSE helpers so the
 *     existing ownerTurn coordinators' plain-string results can be spoken
 *     by ElevenLabs' Custom LLM transport without ElevenLabs' own model
 *     ever re-composing them.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const BINDING_TTL_SECONDS = 10 * 60;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function sessionSigningSecret() {
  const value = process.env.CARSON_SECOND_BRAIN_SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("Second Brain voice-boundary session signing is not configured.");
  return value;
}

export function providerSecret() {
  const value = process.env.CARSON_SECOND_BRAIN_PROVIDER_SECRET;
  if (!value || value.length < 32) throw new Error("Second Brain voice-boundary provider authentication is not configured.");
  return value;
}

function sign(encodedPayload, secret) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

/**
 * Fresh owner-authenticated binding, mirrors no prior file's implementation.
 *
 * Carries a short-lived SNAPSHOT of the owner's own Supabase access token
 * (`jwt`), not just an account id — this is deliberate: the existing,
 * already-hardened evidence-fetch functions this boundary reuses unchanged
 * (fetchAttentionEvidenceThroughServerPath / readCalendarThroughExistingHandler
 * in api/carson-turn.js) authorize every read with the CALLER'S OWN verified
 * JWT so PostgREST/RLS scope exactly as they would for the authenticated
 * browser client — never the service-role key (see
 * api/_carson-attention-evidence.js's own header comment, and the real,
 * negative-controlled RLS verification workflow that proves it). Embedding
 * the JWT here is safer than a bare pass-through: it adds HMAC tamper
 * protection and a hard expiry (10 minutes) strictly shorter than the JWT's
 * own, while requiring zero changes to that already-tested RLS boundary.
 */
export function createSessionBinding({ accountId, jwt, now = Date.now() }, secret = sessionSigningSecret()) {
  const issuedAt = Math.floor(now / 1_000);
  const payload = { v: 1, sub: accountId, jwt, sid: randomUUID(), iat: issuedAt, exp: issuedAt + BINDING_TTL_SECONDS };
  const encodedPayload = base64url(JSON.stringify(payload));
  return { token: `${encodedPayload}.${sign(encodedPayload, secret)}`, payload };
}

export function verifySessionBinding(token, { now = Date.now(), secret } = {}) {
  if (typeof token !== "string") return null;
  const [encodedPayload, suppliedSignature, extra] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extra) return null;
  let expectedSecret;
  try {
    expectedSecret = secret ?? sessionSigningSecret();
  } catch {
    return null;
  }
  const expectedSignature = sign(encodedPayload, expectedSecret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    const nowSeconds = Math.floor(now / 1_000);
    if (payload?.v !== 1 || typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
    if (typeof payload.jwt !== "string" || !payload.jwt) return null;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
    if (payload.iat > nowSeconds + 30 || payload.exp <= nowSeconds || payload.exp - payload.iat !== BINDING_TTL_SECONDS) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Safe, secret-free breakdown of why a binding failed verification — for
 * diagnostics only, never for authorization. Mirrors verifySessionBinding's
 * checks but returns only booleans (never the token, the signature, the
 * owner's JWT, or either secret) so a rejected binding can be diagnosed
 * from server logs without ever exposing anything sensitive.
 */
export function diagnoseSessionBinding(token, { now = Date.now(), secret } = {}) {
  const empty = { binding_present: false, binding_parse_ok: false, binding_signature_ok: false, binding_expired: false, owner_jwt_present: false };
  if (typeof token !== "string" || token.length === 0) return empty;

  const [encodedPayload, suppliedSignature, extra] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extra) return { ...empty, binding_present: true };

  let expectedSecret;
  try {
    expectedSecret = secret ?? sessionSigningSecret();
  } catch {
    return { ...empty, binding_present: true, binding_parse_ok: true };
  }
  const expectedSignature = sign(encodedPayload, expectedSecret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  const signatureOk = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  if (!signatureOk) return { ...empty, binding_present: true, binding_parse_ok: true };

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    const nowSeconds = Math.floor(now / 1_000);
    const expired = typeof payload?.exp === "number" ? payload.exp <= nowSeconds : true;
    const ownerJwtPresent = typeof payload?.jwt === "string" && payload.jwt.length > 0;
    return { binding_present: true, binding_parse_ok: true, binding_signature_ok: true, binding_expired: expired, owner_jwt_present: ownerJwtPresent };
  } catch {
    return { ...empty, binding_present: true, binding_parse_ok: true, binding_signature_ok: true };
  }
}

/**
 * Authenticates the owner requesting a fresh binding via their real
 * Supabase session, and returns the verified JWT alongside the account id
 * so the binding can embed it (see createSessionBinding's doc comment).
 */
export async function authenticateOwner(req) {
  const authorization = req.headers?.authorization ?? req.headers?.Authorization ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: authorization },
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  if (typeof user?.id !== "string") return null;
  return { accountId: user.id, jwt: authorization.slice(7) };
}

export function getBearer(req) {
  const value = req.headers?.authorization ?? req.headers?.Authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

export function equalSecret(actual, expected) {
  const left = Buffer.from(actual || "");
  const right = Buffer.from(expected || "");
  return left.length === right.length && timingSafeEqual(left, right);
}

const VOICE_BINDING_HEADER = "x-carson-second-brain-binding";

/**
 * Deterministic transport precedence for the owner binding: the
 * X-Carson-Second-Brain-Binding header (documented/current path — the
 * ElevenLabs dashboard exposes Request headers, not an extra-body field,
 * for the one-off dashboard "Test Connection" probe) first, then
 * elevenlabs_extra_body (the real per-conversation path, set by
 * ElevenLabsAgentWidget.tsx's startSession call), else undefined — callers
 * fail closed. Never a query string, cookie, or other body field.
 */
export function extractVoiceBindingToken(req) {
  const headerValue = req.headers?.[VOICE_BINDING_HEADER];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof headerToken === "string" && headerToken.length > 0) return headerToken;
  const legacyToken = req.body?.elevenlabs_extra_body?.carson_second_brain_binding;
  return typeof legacyToken === "string" && legacyToken.length > 0 ? legacyToken : undefined;
}

/**
 * True when a request is shaped like ElevenLabs' Custom LLM call (OpenAI
 * chat-completions format: a messages array, no typed-path transcript
 * field) rather than the existing typed-browser call
 * (transcript/turnId/providerEventId, authenticated with the owner's own
 * JWT). Used by api/carson-turn.js to route to this boundary's auth model
 * without disturbing the existing typed request handling at all.
 */
export function looksLikeVoiceBoundaryRequest(req) {
  return Array.isArray(req.body?.messages) && typeof req.body?.transcript !== "string";
}

/** Extracts the latest user-role message text from an OpenAI-shaped messages array. */
export function extractLatestUserMessage(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const content = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join(" ")
        : "";
    return content.trim();
  }
  return "";
}

/**
 * Streams a single canonical text as one OpenAI-compatible chat-completion
 * turn — the exact wire shape ElevenLabs' Custom LLM transport expects.
 * There is deliberately no second generation step here: the text passed in
 * is already the final, grounded ownerResult from the existing
 * coordinateAttention/coordinateCalendar coordinators — this function only
 * relays it, it never composes or rewrites it.
 */
export function streamOwnerResultAsChatCompletion(res, { completionId, text }) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const event = (delta, finishReason = null) => `data: ${JSON.stringify({
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: "carson-second-brain-voice-boundary",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

  res.write(event({ role: "assistant" }));
  res.write(event({ content: text }));
  res.write(event({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}
