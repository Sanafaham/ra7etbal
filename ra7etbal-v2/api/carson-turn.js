import googleCalendarHandler from "./google-calendar.js";
import { createReadOnlyTurnCoordinator, createAttentionReadCoordinator } from "./_carson-read-turn.js";
import { fetchAttentionSummaryForServer } from "./_carson-attention-evidence.js";
import { reasonOverOperationalEvidenceWithClaude } from "./_carson-attention-reasoning.js";

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

export function createCarsonTurnHandler({
  authenticate = requireUser,
  interpretIntent = interpretReadIntentWithClaude,
  readCalendar = readCalendarThroughExistingHandler,
  fetchAttentionEvidence = fetchAttentionEvidenceThroughServerPath,
  reasonOverEvidence = reasonOverOperationalEvidenceWithClaude,
  dedupStore = completedTurns,
} = {}) {
  const coordinateCalendar = createReadOnlyTurnCoordinator({ interpretIntent, readCalendar });
  const coordinateAttention = createAttentionReadCoordinator({
    fetchEvidence: fetchAttentionEvidence,
    reasonOverEvidence,
  });
  return async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
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
    };

    // Deterministic, model-free classification first (attention_summary_read).
    // Only when it doesn't match this class does the existing Claude-based
    // calendar_read path run — unchanged for every non-attention transcript.
    const pendingResult = (async () => {
      const attentionResult = await coordinateAttention(ownerTurn);
      if (attentionResult.handled) return attentionResult;
      const calendarResult = await coordinateCalendar(ownerTurn);
      if (calendarResult.handled) return calendarResult;
      // Neither coordinator claimed this turn. If the attention coordinator
      // specifically classified it as not_attention (a genuine, meaningful
      // decision from active grounded context — distinct from having no
      // candidacy at all), that classification must survive to the caller:
      // the typed widget only knows to fall through to the normal typed
      // path on code:"not_attention", and calendar's own generic
      // unsupported_intent rejection must not silently overwrite it.
      if (attentionResult.code === "not_attention") return attentionResult;
      return calendarResult;
    })();

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
