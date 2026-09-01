import googleCalendarHandler from "./google-calendar.js";
import { createReadOnlyTurnCoordinator, createAttentionReadCoordinator, ATTENTION_CAPABILITY } from "./_carson-read-turn.js";
import { fetchAttentionSummaryForServer } from "./_carson-attention-evidence.js";
import { reasonOverOperationalEvidenceWithClaude } from "./_carson-attention-reasoning.js";
import { createAttentionAgentCoordinator } from "./_carson-attention-agent.js";
import { matchesAttentionIntent } from "../shared/carson-attention-intent-classifier.js";
import {
  providerSecret,
  equalSecret,
  getBearer,
  verifySessionBinding,
  extractVoiceBindingToken,
  diagnoseSessionBinding,
  authenticateOwner,
  createSessionBinding,
  looksLikeVoiceBoundaryRequest,
  extractLatestUserMessage,
  streamOwnerResultAsChatCompletion,
} from "./_carson-second-brain-voice-boundary.js";

const MAX_DEDUP_ENTRIES = 200;
const completedTurns = new Map();

async function requireUser(req) {
  const authorization = req.headers?.authorization ?? req.headers?.Authorization ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: authorization },
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return user?.id ?? null;
}

export async function interpretReadIntentWithClaude(transcript, fetchImpl = fetch) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Anthropic API key is not configured.");
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.CARSON_READ_MODEL ?? "claude-haiku-4-5-20251001",
      max_tokens: 160,
      tool_choice: { type: "tool", name: "select_read_capability" },
      tools: [{
        name: "select_read_capability",
        description: "Select the supported read-only Carson capability. Use unsupported for every request other than reading the owner's upcoming calendar.",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            capability: { type: "string", enum: ["calendar_read", "unsupported"] },
            range: { type: "string", enum: ["today", "tomorrow", "this_week", "next_week", "next_7_days", "next_10_days", "next_14_days", "next_30_days"] },
          },
          required: ["capability", "range"],
          additionalProperties: false,
        },
      }],
      messages: [{ role: "user", content: transcript }],
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error("Claude intent request failed.");
  const toolUse = body.content?.find((block) => block?.type === "tool_use" && block?.name === "select_read_capability");
  if (!toolUse?.input) throw new Error("Claude returned no structured intent.");
  return toolUse.input;
}

/**
 * Stage 1 semantic routing classifier (2026-08-28, structured Second Brain
 * admission correction).
 *
 * ONLY runs for a typed turn that matched neither the deterministic
 * matchesAttentionIntent fast path nor active grounded operational
 * continuation — see createCarsonTurnHandler below. Intentionally coarse
 * and binary: is this a novel natural-language operational-state question
 * (Needs You / overdue / upcoming reminders / waiting / other active items),
 * or not? It does NOT decide calendar vs. unrelated — a "not operational"
 * result falls through to the existing, unchanged calendar coordinator,
 * which runs its own classification exactly as it always has. This keeps
 * natural-language understanding entirely in the reasoning/classification
 * layer (never a client or server regex) without expanding into a large
 * taxonomy or duplicating calendar's own intent logic.
 *
 * Receives ONLY the transcript — no tenant data, no evidence, no
 * accountId/authorization — same input-privacy contract as
 * interpretReadIntentWithClaude above.
 */
export async function classifyOperationalIntentWithClaude(transcript, fetchImpl = fetch) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Anthropic API key is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let response;
  try {
    response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.CARSON_READ_MODEL ?? "claude-haiku-4-5-20251001",
        max_tokens: 80,
        tool_choice: { type: "tool", name: "classify_operational_intent" },
        tools: [{
          name: "classify_operational_intent",
          description:
            "Classify whether the owner's message is a natural-language question about their own " +
            "Ra7etBal operational state — things needing their decision, overdue reminders, upcoming " +
            "reminders, things waiting on other people, or other active items (e.g. 'anything overdue?', " +
            "'what am I waiting on?', 'do I need to deal with anything now?', 'what can wait?'). Use " +
            "not_operational for anything else, including calendar questions and unrelated requests.",
          strict: true,
          input_schema: {
            type: "object",
            properties: {
              classification: { type: "string", enum: ["operational_state_read", "not_operational"] },
            },
            required: ["classification"],
            additionalProperties: false,
          },
        }],
        messages: [{ role: "user", content: transcript }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error("Claude classification request failed.");
  const toolUse = body.content?.find((block) => block?.type === "tool_use" && block?.name === "classify_operational_intent");
  if (!toolUse?.input?.classification) throw new Error("Claude returned no structured classification.");
  return toolUse.input.classification;
}

export async function fetchAttentionEvidenceThroughServerPath({ authorization }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new Error("Supabase server configuration is missing.");
  return fetchAttentionSummaryForServer({ supabaseUrl, anonKey, authorization });
}

export async function readCalendarThroughExistingHandler({ authorization, range }, handler = googleCalendarHandler) {
  let statusCode = 200;
  let payload = null;
  const req = { method: "GET", query: { range, suppressCredentialCleanup: "true" }, headers: { authorization } };
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
    setHeader() { return this; },
  };
  await handler(req, res);
  if (statusCode < 200 || statusCode >= 300) throw new Error("Calendar read failed.");
  return payload;
}

function remember(store, key, value) {
  store.set(key, value);
  if (store === completedTurns && store.size > MAX_DEDUP_ENTRIES) store.delete(store.keys().next().value);
}

/**
 * Admission (2026-08-28, structured Second Brain admission correction),
 * extracted (2026-09-01, Second Brain Slice 2 voice boundary) so BOTH the
 * existing typed-browser path and the new ElevenLabs voice-boundary path
 * (createCarsonTurnHandler below) run through the identical
 * attention/calendar routing decision — one coordination path, not two
 * that could silently diverge on the same input:
 *
 * 1. Deterministic known-phrase fast path + active grounded operational
 *    continuation — unchanged, zero model cost, handled entirely inside
 *    coordinateAttention's own admission check.
 * 2. Otherwise, ONE coarse Stage 1 semantic classification (transcript
 *    only, no tenant data, no evidence) decides whether this novel
 *    message is a natural-language operational-state question. This is
 *    what lets a fresh-session question like "Anything overdue?" reach
 *    the reasoning layer without ever needing a phrase-specific regex.
 * 3. Exactly ONE coordinator runs per turn — the attention/operational
 *    path when Stage 1 (or a fast path) admits it, otherwise the
 *    existing, entirely unchanged calendar coordinator (which performs
 *    its own classification exactly as it always has). This single-path
 *    routing is also what makes the composition ambiguity fixed in
 *    PR #363 impossible to reintroduce — no two coordinators are ever
 *    both invoked for the same turn, so there is nothing left to
 *    silently overwrite.
 */
export async function coordinateOwnerTurn(ownerTurn, { coordinateAttention, coordinateCalendar, classifyOperationalIntent }) {
  const isDirectAttentionIntent = matchesAttentionIntent(ownerTurn.transcript);
  const hasActiveGroundedAttentionContext =
    ownerTurn.previousCapability === ATTENTION_CAPABILITY && ownerTurn.previousGroundingStatus === "grounded";

  if (isDirectAttentionIntent || hasActiveGroundedAttentionContext) {
    const attentionResult = await coordinateAttention(ownerTurn);
    if (attentionResult.handled) return attentionResult;
    const calendarResult = await coordinateCalendar(ownerTurn);
    if (calendarResult.handled) return calendarResult;
    if (attentionResult.code === "not_attention" && calendarResult.code === "unsupported_intent") {
      return attentionResult;
    }
    return calendarResult;
  }

  let stage1Classification;
  try {
    stage1Classification = await classifyOperationalIntent(ownerTurn.transcript);
  } catch {
    stage1Classification = "not_operational";
  }

  if (stage1Classification === "operational_state_read") {
    return coordinateAttention({ ...ownerTurn, stage1Admitted: true });
  }

  return coordinateCalendar(ownerTurn);
}

/**
 * Second Brain Slice 2 — the ElevenLabs Custom LLM voice-boundary branch.
 * Provider secret + owner binding replace the typed path's direct owner
 * JWT (ElevenLabs calls this endpoint server-to-server, not the browser),
 * but from coordinateOwnerTurn onward this reuses the EXACT SAME
 * coordinators (and therefore the exact same evidence, classification, and
 * grounding guarantees) as typed Carson. The result is streamed back as
 * one OpenAI-compatible chat-completion turn — never a second, independent
 * generation — so what ElevenLabs speaks IS the grounded ownerResult, not
 * ElevenLabs' own hosted model's paraphrase of it.
 */
async function handleVoiceBoundaryRequest(req, res, { coordinateAttention, coordinateCalendar, classifyOperationalIntent }) {
  let expectedProviderSecret;
  try {
    expectedProviderSecret = providerSecret();
  } catch {
    return res.status(503).json({ error: "Provider authentication unavailable" });
  }
  if (!equalSecret(getBearer(req), expectedProviderSecret)) {
    // Diagnostic only — never the secret or the caller-supplied value, just
    // whether a bearer token was present at all.
    console.warn("[carson-second-brain-voice-boundary] provider_rejected", {
      provider_secret_present: getBearer(req).length > 0,
    });
    return res.status(401).json({ error: "Unauthorized provider" });
  }

  const token = extractVoiceBindingToken(req);
  const binding = verifySessionBinding(token);
  if (!binding) {
    // Safe, secret-free breakdown (see diagnoseSessionBinding's doc
    // comment) — the only way to tell "no binding attached at all" from
    // "signature mismatch" from "expired" from Vercel's own logs, without
    // ever logging the token, the JWT, or either secret.
    console.warn("[carson-second-brain-voice-boundary] binding_rejected", diagnoseSessionBinding(token));
    return res.status(401).json({ error: "Invalid or expired session binding" });
  }

  const transcript = extractLatestUserMessage(req.body?.messages).trim();
  if (!transcript) return res.status(400).json({ error: "No authoritative owner turn" });

  const ownerTurn = {
    accountId: binding.sub,
    authorization: `Bearer ${binding.jwt}`,
    providerEventId: "",
    turnId: binding.sid,
    transcript,
    legacyClaimed: false,
    previousCapability: null,
    previousGroundingStatus: null,
    previouslySurfacedEvidenceIds: [],
    priorObjective: null,
  };

  let result;
  try {
    result = await coordinateOwnerTurn(ownerTurn, { coordinateAttention, coordinateCalendar, classifyOperationalIntent });
  } catch {
    return res.status(502).json({ error: "Turn coordination failed" });
  }
  const completionId = `sb_${binding.sid}_${Date.now()}`;
  // Never the raw result JSON — only its ownerResult text is spoken. Binding
  // token, JWT, and account id never appear in the response.
  return streamOwnerResultAsChatCompletion(res, {
    completionId,
    text: result?.ownerResult ?? "I couldn't confirm that. Please try again.",
  });
}

export function createCarsonTurnHandler({
  authenticate = requireUser,
  interpretIntent = interpretReadIntentWithClaude,
  classifyOperationalIntent = classifyOperationalIntentWithClaude,
  readCalendar = readCalendarThroughExistingHandler,
  fetchAttentionEvidence = fetchAttentionEvidenceThroughServerPath,
  reasonOverEvidence = reasonOverOperationalEvidenceWithClaude,
  // OpenAI Agents SDK vertical slice (2026-08-30, owner decision after
  // repeated Stage 1/2 production canary failures) — runAgent/buildAgent
  // are DI-only for tests; production always uses their real defaults
  // inside createAttentionAgentCoordinator itself.
  runAgent,
  buildAgent,
  dedupStore = completedTurns,
} = {}) {
  const coordinateCalendar = createReadOnlyTurnCoordinator({ interpretIntent, readCalendar });
  // CARSON_OPENAI_AGENT_ATTENTION_V1: narrow, owner-only production flag.
  // Disabled (default): the existing Stage 1/2 typed attention path is
  // unchanged below. Enabled: the SAME admission/routing logic below picks
  // which coordinator answers an admitted attention turn — nothing else
  // about admission, calendar fallback, dedup, or the not_attention
  // contract changes.
  const coordinateAttention =
    process.env.CARSON_OPENAI_AGENT_ATTENTION_V1 === "1"
      ? createAttentionAgentCoordinator({
          fetchEvidence: fetchAttentionEvidence,
          ...(runAgent ? { runAgent } : {}),
          ...(buildAgent ? { buildAgent } : {}),
        })
      : createAttentionReadCoordinator({
          fetchEvidence: fetchAttentionEvidence,
          reasonOverEvidence,
        });
  return async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // Second Brain Slice 2 — owner-authenticated binding issuance for the
    // ElevenLabs voice boundary. Reuses the caller's real Supabase session
    // (same trust model as the rest of this file's typed path); never
    // issues a binding without it.
    if (req.body?.action === "issue_second_brain_voice_binding") {
      const owner = await authenticateOwner(req);
      if (!owner) return res.status(401).json({ error: "Unauthorized" });
      const { token, payload } = createSessionBinding(owner);
      return res.status(200).json({ binding: token, sessionId: payload.sid, expiresAt: payload.exp });
    }

    // Second Brain Slice 2 — ElevenLabs Custom LLM calls this endpoint
    // server-to-server (provider secret + owner binding), never with the
    // owner's own JWT the typed path below expects. Detected by request
    // shape alone (an OpenAI-style messages array, no typed transcript
    // field) so the existing typed path is completely untouched.
    if (looksLikeVoiceBoundaryRequest(req)) {
      return handleVoiceBoundaryRequest(req, res, { coordinateAttention, coordinateCalendar, classifyOperationalIntent });
    }

    const accountId = await authenticate(req);
    if (!accountId) return res.status(401).json({ handled: true, code: "unauthorized", ownerResult: "Please sign in again before I read your calendar." });

    const providerEventId = typeof req.body?.providerEventId === "string" ? req.body.providerEventId.trim() : "";
    const turnId = typeof req.body?.turnId === "string" ? req.body.turnId.trim() : "";
    const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim() : "";
    const dedupKey = providerEventId ? `${accountId}:${providerEventId}` : "";
    if (dedupKey && dedupStore.has(dedupKey)) {
      const cached = await Promise.resolve(dedupStore.get(dedupKey));
      return res.status(cached.status).json({ ...cached, duplicate: true });
    }

    // previousCapability/previousGroundingStatus: minimal, non-security
    // conversational-continuity context only (see
    // createAttentionReadCoordinator's own doc comment) — never trusted for
    // identity, authorization, or in place of fresh retrieval.
    const ownerTurn = {
      accountId,
      authorization: req.headers?.authorization ?? req.headers?.Authorization ?? "",
      providerEventId,
      turnId,
      transcript,
      legacyClaimed: req.body?.legacyClaimed === true,
      previousCapability: typeof req.body?.previousCapability === "string" ? req.body.previousCapability : null,
      previousGroundingStatus:
        typeof req.body?.previousGroundingStatus === "string" ? req.body.previousGroundingStatus : null,
      // Second Brain reasoning conversation state (2026-08-28) — same
      // non-authoritative trust tier as the two fields above. Never used
      // for identity/tenant scoping; only passed through to the reasoning
      // model as classification/selection context.
      previouslySurfacedEvidenceIds: Array.isArray(req.body?.previouslySurfacedEvidenceIds)
        ? req.body.previouslySurfacedEvidenceIds.filter((id) => typeof id === "string")
        : [],
      priorObjective: typeof req.body?.priorObjective === "string" ? req.body.priorObjective : null,
      // NOTE (2026-08-30, CodeRabbit finding on PR #381): a client-supplied
      // previousResponseId was deliberately removed here — it would have
      // been an unauthenticated pointer into OpenAI's own stored
      // conversation state, forwarded to OpenAI without any verification
      // that it actually belonged to this account/session. req.body's
      // previousResponseId (if a client sends one) is intentionally never
      // read into ownerTurn, so it can never reach runAgent. See
      // api/_carson-attention-agent.js's file-level doc comment.
    };

    // Admission logic lives in coordinateOwnerTurn (above) — unchanged
    // behavior, now shared with the voice boundary branch above.
    const pendingResult = coordinateOwnerTurn(ownerTurn, { coordinateAttention, coordinateCalendar, classifyOperationalIntent });

    if (dedupKey) remember(dedupStore, dedupKey, pendingResult);
    const result = await pendingResult;
    if (dedupKey && result.handled) {
      remember(dedupStore, dedupKey, result);
    } else if (dedupKey) {
      dedupStore.delete(dedupKey);
    }
    return res.status(result.status).json(result);
  };
}

export default createCarsonTurnHandler();
