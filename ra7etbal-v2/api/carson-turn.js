import googleCalendarHandler from "./google-calendar.js";
import { createReadOnlyTurnCoordinator } from "./_carson-read-turn.js";

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
  dedupStore = completedTurns,
} = {}) {
  const coordinate = createReadOnlyTurnCoordinator({ interpretIntent, readCalendar });
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

    const pendingResult = coordinate({
      accountId,
      authorization: req.headers?.authorization ?? req.headers?.Authorization ?? "",
      providerEventId,
      turnId,
      transcript,
      legacyClaimed: req.body?.legacyClaimed === true,
    });
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
