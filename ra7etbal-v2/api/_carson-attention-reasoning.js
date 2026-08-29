/**
 * Second Brain stateful reasoning boundary for structured operational
 * evidence (2026-08-28, revised for the structured multi-category
 * evidence contract — replaces the prior flat needsAttention/waiting
 * version, same file/exports).
 *
 * reasonOverOperationalEvidence() is the provider-independent capability
 * contract: given the user's message, minimal non-authoritative
 * conversation state, and the FRESH, already RLS-authorized structured
 * evidence for this turn (needsYou/overdueReminders/upcomingReminders/
 * waiting/later/unresolvedCaptures), it returns a structured decision
 * about which evidence is relevant and how to frame the response — never
 * free-form operational text. The default implementation below reuses the
 * exact strict-tool-output Anthropic pattern already proven in
 * api/carson-turn.js's interpretReadIntentWithClaude — same calling
 * convention, same dependency-injection shape (fetchImpl).
 *
 * The model is NEVER the source of factual text or category labels. It
 * only selects/ranks/contrasts the evidence ids it was given — see
 * shared/carson-attention-summary.js's renderAttentionDecision() for the
 * deterministic renderer that turns a validated decision into the actual
 * response, using only each item's own already-known label/category.
 */

export const RESPONSE_INTENTS = [
  "list",
  "rank",
  "contrast",
  "explain",
  "nothing_new",
  "clarify",
  "not_attention",
];

function collectEvidenceIds(evidence) {
  const items = [
    ...(evidence.needsYou ?? []),
    ...(evidence.overdueReminders ?? []),
    ...(evidence.upcomingReminders ?? []),
    ...(evidence.waiting ?? []),
    ...(evidence.later ?? []),
    ...(evidence.unresolvedCaptures ?? []),
  ];
  return items.map((item) => item.id);
}

const CATEGORY_HEADERS = {
  needsYou: "Needs your decision",
  overdueReminders: "Overdue",
  upcomingReminders: "Coming up",
  waiting: "Waiting on others",
  later: "Other active items (not currently urgent)",
  unresolvedCaptures: "On your mind (notes/to-dos)",
};

function describeEvidenceForModel(evidence) {
  const lines = [];
  const section = (category, items) => {
    if (!items?.length) return;
    lines.push(`${CATEGORY_HEADERS[category]}:`);
    for (const item of items) {
      const dueBit = item.dueDescription ? ` | ${item.dueDescription}` : "";
      lines.push(`  - id=${item.id} | ${item.label}${dueBit}`);
    }
  };
  section("needsYou", evidence.needsYou);
  section("overdueReminders", evidence.overdueReminders);
  section("upcomingReminders", evidence.upcomingReminders);
  section("waiting", evidence.waiting);
  section("later", evidence.later);
  section("unresolvedCaptures", evidence.unresolvedCaptures);
  if (lines.length === 0) lines.push("(no operational items currently on record)");
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
      "Decide how to respond to the owner's message about their operational state (Needs You decisions, " +
      "overdue reminders, upcoming reminders, things waiting on others, other active items, or notes/to-dos). " +
      "Each evidence item already carries its own true category — you select/rank/contrast ids, you never " +
      "invent a category or a fact. You may only select, rank, or reference evidence ids that were supplied " +
      "to you. Never invent an id. Use 'contrast' when the question asks for a genuine distinction (e.g. what " +
      "can wait vs what can't) — selectedEvidenceIds holds the primary answer set, contrastedEvidenceIds holds " +
      "the secondary set being contrasted against. Use 'rank' when asked to order/prioritize — " +
      "rankedEvidenceIds must be an ordering of selectedEvidenceIds. If the message is not about the owner's " +
      "operational state at all (e.g. a new unrelated request), return responseIntent 'not_attention'. " +
      "You must always include every field below — use an empty array [] or null when a field does not " +
      "apply to your decision; never omit a field.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        responseIntent: { type: "string", enum: RESPONSE_INTENTS },
        selectedEvidenceIds: { type: "array", items: { type: "string", enum: idEnum } },
        rankedEvidenceIds: { type: ["array", "null"], items: { type: "string", enum: idEnum } },
        contrastedEvidenceIds: { type: ["array", "null"], items: { type: "string", enum: idEnum } },
        needsClarification: { type: ["string", "null"] },
      },
      // ALL properties are required (2026-08-28 fix for a confirmed
      // production failure): with only responseIntent/selectedEvidenceIds
      // marked required, Anthropic's strict tool-output mode did not
      // reliably enforce their presence at this schema size (a 22-item id
      // enum repeated across three array properties) — the model returned
      // a bare {"responseIntent":"list"} with selectedEvidenceIds entirely
      // omitted, correctly rejected by validateAttentionDecision and
      // correctly falling back, but too often to be useful. Making every
      // property required (with the genuinely-optional ones typed
      // nullable, the standard strict-mode pattern) forces the model to
      // always emit selectedEvidenceIds, using null/[] for the rest when
      // not applicable — validateAttentionDecision treats null the same
      // as absent for the nullable fields.
      required: [
        "responseIntent",
        "selectedEvidenceIds",
        "rankedEvidenceIds",
        "contrastedEvidenceIds",
        "needsClarification",
      ],
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
    "Fresh, authorized operational evidence for THIS turn (the only facts you may use — each item's category is already true and factual, do not relabel it):",
    describeEvidenceForModel(authorizedEvidence),
    "",
    `Owner's new message: "${userMessage}"`,
  ].join("\n");

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
        max_tokens: 500,
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
  if (decision.rankedEvidenceIds !== undefined && decision.rankedEvidenceIds !== null) {
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

  let contrastedEvidenceIds;
  if (decision.contrastedEvidenceIds !== undefined && decision.contrastedEvidenceIds !== null) {
    if (!Array.isArray(decision.contrastedEvidenceIds)) return { ok: false };
    const isValidContrast = decision.contrastedEvidenceIds.every(
      (id) => typeof id === "string" && authorizedIds.has(id),
    );
    // Same soft-degrade philosophy as ranking — an invalid contrast set
    // degrades to "no contrast" rather than rejecting the whole decision,
    // since every id in it is still checked against the SAME authorized
    // universe (never a separate, less-trusted set).
    contrastedEvidenceIds = isValidContrast ? decision.contrastedEvidenceIds : undefined;
  }

  if (
    decision.selectedEvidenceIds.length === 0 &&
    decision.responseIntent !== "nothing_new" &&
    decision.responseIntent !== "clarify" &&
    decision.responseIntent !== "not_attention" &&
    !(decision.responseIntent === "contrast" && contrastedEvidenceIds?.length > 0)
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
      contrastedEvidenceIds,
      needsClarification,
    },
  };
}
