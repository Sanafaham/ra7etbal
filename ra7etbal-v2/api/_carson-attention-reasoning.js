/**
 * Second Brain stateful reasoning boundary for attention_summary_read
 * (2026-08-28).
 *
 * reasonOverOperationalEvidence() is the provider-independent capability
 * contract: given the user's message, minimal non-authoritative
 * conversation state, and the FRESH, already RLS-authorized evidence for
 * this turn, it returns a structured decision about which evidence is
 * relevant and how to frame the response — never free-form operational
 * text. The default implementation below reuses the exact strict-tool-
 * output Anthropic pattern already proven in api/carson-turn.js's
 * interpretReadIntentWithClaude — same calling convention, same
 * dependency-injection shape (fetchImpl), so a different provider is a
 * drop-in adapter with the same input/output contract, not a rewrite of
 * this module's caller.
 *
 * The model is NEVER the source of factual text. It only selects/ranks/
 * classifies over the evidence ids it was given — see
 * shared/carson-attention-summary.js's renderAttentionDecision() for the
 * deterministic renderer that turns a validated decision into the actual
 * response, using only each item's own already-known label/reason.
 */

const RESPONSE_INTENTS = [
  "list",
  "prioritize",
  "filter_urgent",
  "explain",
  "nothing_new",
  "clarify",
  "not_attention",
];

function collectEvidenceIds(evidence) {
  const items = [
    ...(evidence.needsAttention ?? []),
    ...(evidence.waiting ?? []),
    ...(evidence.unresolvedCaptures ?? []),
  ];
  return items.map((item) => item.id);
}

function describeEvidenceForModel(evidence) {
  const lines = [];
  const section = (label, items) => {
    if (!items?.length) return;
    lines.push(`${label}:`);
    for (const item of items) {
      lines.push(`  - id=${item.id} | ${item.label} | reason: ${item.reason}`);
    }
  };
  section("Needs attention", evidence.needsAttention);
  section("Waiting", evidence.waiting);
  section("On the owner's mind (notes/to-dos)", evidence.unresolvedCaptures);
  if (lines.length === 0) lines.push("(no items currently need attention)");
  return lines.join("\n");
}

function buildToolSchema(evidenceIds) {
  // A non-empty placeholder keeps the JSON schema itself valid when there
  // is no live evidence this turn — the model can still return an empty
  // selectedEvidenceIds array (validated below); the enum only bounds what
  // a NON-empty selection may contain.
  const idEnum = evidenceIds.length > 0 ? evidenceIds : ["__no_evidence__"];
  return {
    name: "decide_attention_response",
    description:
      "Decide how to respond to the owner's message about their operational attention items. " +
      "You may only select, rank, or reference evidence ids that were supplied to you. " +
      "Never invent an id. If the message is not about the attention/operational-state topic " +
      "at all (e.g. a new unrelated request), return responseIntent 'not_attention'.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        responseIntent: { type: "string", enum: RESPONSE_INTENTS },
        selectedEvidenceIds: { type: "array", items: { type: "string", enum: idEnum } },
        rankedEvidenceIds: { type: "array", items: { type: "string", enum: idEnum } },
        needsClarification: { type: ["string", "null"] },
      },
      required: ["responseIntent", "selectedEvidenceIds"],
      additionalProperties: false,
    },
  };
}

/**
 * Default provider adapter — Claude, strict tool-output, same shape as
 * interpretReadIntentWithClaude. Returns the raw (not-yet-validated)
 * decision object; validation against the authorized evidence set is the
 * caller's (coordinator's) responsibility — this module never sees
 * accountId/authorization and cannot influence tenant scoping.
 */
export async function reasonOverOperationalEvidenceWithClaude(
  { userMessage, conversationState, authorizedEvidence },
  fetchImpl = fetch,
) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Anthropic API key is not configured.");

  const evidenceIds = collectEvidenceIds(authorizedEvidence);
  const stateLines = [
    `Prior capability: ${conversationState?.priorCapability ?? "none"}`,
    `Prior grounding status: ${conversationState?.priorGroundingStatus ?? "none"}`,
    `Prior objective: ${conversationState?.priorObjective ?? "none"}`,
    `Previously surfaced evidence ids (already mentioned, may still be referenced if relevant): ${
      (conversationState?.previouslySurfacedEvidenceIds ?? []).join(", ") || "none"
    }`,
  ];

  const prompt = [
    "Conversation state:",
    ...stateLines,
    "",
    "Fresh, authorized evidence for THIS turn (the only facts you may use):",
    describeEvidenceForModel(authorizedEvidence),
    "",
    `Owner's new message: "${userMessage}"`,
  ].join("\n");

  // Bounded so a stalled provider call rejects in time for the coordinator's
  // fallback path to run, instead of stalling until the platform's own
  // function timeout silently drops the honest-fallback contract.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
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
        model: process.env.CARSON_REASONING_MODEL ?? "claude-haiku-4-5-20251001",
        max_tokens: 400,
        tool_choice: { type: "tool", name: "decide_attention_response" },
        tools: [buildToolSchema(evidenceIds)],
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error("Reasoning model request failed.");
  const toolUse = body.content?.find(
    (block) => block?.type === "tool_use" && block?.name === "decide_attention_response",
  );
  if (!toolUse?.input) throw new Error("Reasoning model returned no structured decision.");
  return toolUse.input;
}

/**
 * Validates a raw model decision against the authorized fresh evidence for
 * this exact turn. This is the hard boundary: an unknown/invented id, an
 * unknown responseIntent, or a malformed shape all fail validation — the
 * caller must then fall back to deterministic behavior, never trust the
 * decision. Exported separately from the provider call so it can be
 * exercised directly in tests without a network dependency.
 */
export function validateAttentionDecision(decision, authorizedEvidence) {
  if (!decision || typeof decision !== "object") return { ok: false };
  if (!RESPONSE_INTENTS.includes(decision.responseIntent)) return { ok: false };
  if (!Array.isArray(decision.selectedEvidenceIds)) return { ok: false };

  const authorizedIds = new Set(collectEvidenceIds(authorizedEvidence));
  for (const id of decision.selectedEvidenceIds) {
    if (typeof id !== "string" || !authorizedIds.has(id)) return { ok: false };
  }

  let rankedEvidenceIds;
  if (decision.rankedEvidenceIds !== undefined) {
    if (!Array.isArray(decision.rankedEvidenceIds)) return { ok: false };
    const selectedSet = new Set(decision.selectedEvidenceIds);
    const isValidRanking = decision.rankedEvidenceIds.every(
      (id) => typeof id === "string" && selectedSet.has(id),
    );
    // A malformed ranking degrades softly to "no ranking" rather than
    // rejecting the whole decision — ordering is a quality concern, not a
    // grounding one.
    rankedEvidenceIds = isValidRanking ? decision.rankedEvidenceIds : undefined;
  }

  if (
    decision.selectedEvidenceIds.length === 0 &&
    decision.responseIntent !== "nothing_new" &&
    decision.responseIntent !== "clarify" &&
    decision.responseIntent !== "not_attention"
  ) {
    return { ok: false };
  }

  const needsClarification =
    typeof decision.needsClarification === "string" && decision.needsClarification.trim()
      ? decision.needsClarification.trim()
      : null;

  return {
    ok: true,
    decision: {
      responseIntent: decision.responseIntent,
      selectedEvidenceIds: decision.selectedEvidenceIds,
      rankedEvidenceIds,
      needsClarification,
    },
  };
}
