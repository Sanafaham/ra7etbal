import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const STAGE2A_RESPONSE = "Boundary proof successful.";
const BINDING_TTL_SECONDS = 10 * 60;
const MAX_TRANSCRIPT_LENGTH = 4_000;
const retryAttempts = new Map();

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signingSecret() {
  const value = process.env.CARSON_STAGE2A_SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("Stage 2A session signing is not configured.");
  return value;
}

function providerSecret() {
  const value = process.env.CARSON_STAGE2A_PROVIDER_SECRET;
  if (!value || value.length < 32) throw new Error("Stage 2A provider authentication is not configured.");
  return value;
}

function sign(encodedPayload, secret = signingSecret()) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createSessionBinding({ accountId, now = Date.now(), scenario = "fixed" }, secret) {
  const issuedAt = Math.floor(now / 1_000);
  const payload = {
    v: 1,
    sub: accountId,
    sid: randomUUID(),
    iat: issuedAt,
    exp: issuedAt + BINDING_TTL_SECONDS,
    scenario: ["fixed", "delayed", "retry_once"].includes(scenario) ? scenario : "fixed",
  };
  const encodedPayload = base64url(JSON.stringify(payload));
  return { token: `${encodedPayload}.${sign(encodedPayload, secret)}`, payload };
}

export function verifySessionBinding(token, { now = Date.now(), secret } = {}) {
  if (typeof token !== "string") return null;
  const [encodedPayload, suppliedSignature, extra] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extra) return null;
  const expectedSignature = sign(encodedPayload, secret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    const nowSeconds = Math.floor(now / 1_000);
    if (payload?.v !== 1 || typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
    if (payload.iat > nowSeconds + 30 || payload.exp <= nowSeconds || payload.exp - payload.iat !== BINDING_TTL_SECONDS) return null;
    if (!["fixed", "delayed", "retry_once"].includes(payload.scenario)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function extractLatestOwnerMessage(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const content = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join(" ")
        : "";
    return content.trim().slice(0, MAX_TRANSCRIPT_LENGTH);
  }
  return "";
}

function stableTurnIdentity({ sessionId, messages, transcript }) {
  const turns = Array.isArray(messages) ? messages.filter((message) => message?.role === "user").length : 0;
  const digest = createHash("sha256").update(`${sessionId}\n${turns}\n${transcript}`).digest("hex").slice(0, 24);
  return `stage2a_${sessionId}_${turns}_${digest}`;
}

function getBearer(req) {
  const value = req.headers?.authorization ?? req.headers?.Authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function equalSecret(actual, expected) {
  const left = Buffer.from(actual || "");
  const right = Buffer.from(expected || "");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function authenticateOwner(req) {
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
  return typeof user?.id === "string" ? user.id : null;
}

function json(res, status, body) {
  res.status(status).json(body);
}

function streamFixedCompletion(req, res, { completionId, scenario }) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let closed = false;
  req.on?.("aborted", () => { closed = true; });
  res.on?.("close", () => { closed = true; });
  const write = (value) => { if (!closed && !res.writableEnded) res.write(value); };
  const event = (delta, finishReason = null) => `data: ${JSON.stringify({
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: "carson-stage2a-fixed",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

  write(event({ role: "assistant" }));
  const delay = scenario === "delayed" ? 3_000 : 0;
  setTimeout(() => {
    if (closed || res.writableEnded) return;
    write(event({ content: STAGE2A_RESPONSE }));
    write(event({}, "stop"));
    write("data: [DONE]\n\n");
    res.end();
  }, delay);
}

export function createStage2aHandler({ authenticate = authenticateOwner } = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    if (req.body?.action === "issue_session_binding") {
      const accountId = await authenticate(req);
      if (!accountId) return json(res, 401, { error: "Unauthorized" });
      const { token, payload } = createSessionBinding({ accountId, scenario: req.body?.scenario });
      return json(res, 200, { binding: token, sessionId: payload.sid, expiresAt: payload.exp });
    }

    let expectedProviderSecret;
    try { expectedProviderSecret = providerSecret(); } catch { return json(res, 503, { error: "Provider authentication unavailable" }); }
    if (!equalSecret(getBearer(req), expectedProviderSecret)) return json(res, 401, { error: "Unauthorized provider" });

    const token = req.body?.elevenlabs_extra_body?.carson_stage2a_binding;
    const binding = verifySessionBinding(token);
    if (!binding) return json(res, 401, { error: "Invalid or expired session binding" });
    const transcript = extractLatestOwnerMessage(req.body?.messages);
    if (!transcript) return json(res, 400, { error: "No authoritative owner turn" });
    const completionId = stableTurnIdentity({ sessionId: binding.sid, messages: req.body.messages, transcript });

    // Non-production provider evidence only. Never log transcript text, tokens,
    // account ids, or request headers.
    console.info("[carson-stage2a-provider]", {
      completionId,
      sessionId: binding.sid,
      scenario: binding.scenario,
      messageCount: req.body.messages.length,
      userTurnCount: req.body.messages.filter((message) => message?.role === "user").length,
      providerRequestId: req.headers?.["x-request-id"] ?? null,
      conversationId: req.body?.conversation_id ?? req.body?.conversationId ?? null,
    });

    if (binding.scenario === "retry_once") {
      const attempts = (retryAttempts.get(completionId) ?? 0) + 1;
      retryAttempts.set(completionId, attempts);
      if (attempts === 1) return json(res, 503, { error: "Intentional Stage 2A first-attempt failure" });
    }
    return streamFixedCompletion(req, res, { completionId, scenario: binding.scenario });
  };
}

export default createStage2aHandler();
