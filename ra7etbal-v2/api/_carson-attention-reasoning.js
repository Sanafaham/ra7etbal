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

// Exported (2026-08-29, Turn 4 diagnostic hardening — CodeRabbit finding on
// PR #376) so api/_carson-read-turn.js's diagnostic-only logging can
// allowlist a raw, pre-validation responseIntent against this exact same
// list rather than trusting it as safe to log verbatim.
export const RESPONSE_INTENTS = [
  "list",
  "rank",
  "contrast",
  "explain",
  "defer_timing",
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
      "to you. Never invent an id. Use 'contrast' when the question asks for a genuine two-sided distinction " +
      "between two sets of items you can both name from the evidence (e.g. items assigned to one person vs " +
      "another) — selectedEvidenceIds holds the primary set, contrastedEvidenceIds holds the secondary set. " +
      "Use 'defer_timing' when the question is about deferral, postponement, or timing — e.g. 'what can wait', " +
      "'what can I leave until later', 'what doesn't need doing yet', 'is there anything I can postpone' — put " +
      "every active item relevant to the question in selectedEvidenceIds; do NOT decide yourself which of them " +
      "are overdue, not due yet, or safe to defer — the server derives that from each item's own due date, " +
      "never from its category or from your judgment, because due timing alone does not establish true " +
      "importance or safety to postpone. Use 'rank' when asked to order/prioritize — rankedEvidenceIds must be " +
      "an ordering of selectedEvidenceIds. If the message is not about the owner's operational state at all " +
      "(e.g. a new unrelated request), return responseIntent 'not_attention'. You must always include every " +
      "field below — use an empty array [] or null when a field does not apply to your decision; never omit " +
      "a field.",
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
  // 2026-08-30 (Turn 4 canary FAIL, live production diagnostic proof): the
  // prior 8000ms budget was too tight for a real-world Claude Haiku
  // tool-use round-trip under production latency — production logs showed
  // this exact call aborting on a genuine owner turn. 15000ms is a modest,
  // still-bounded increase; this is the entire fix, no retry/model/prompt
  // change accompanies it.
  const timeout = setTimeout(() => controller.abort(), 15000);
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
  if (!response.ok || !body) {
    // httpStatus attached (2026-08-30, Turn 4 diagnostic hardening) so the
    // caller's diagnostic logging can safely record the numeric status
    // only — never the response body, headers, or provider error text —
    // to distinguish an HTTP-level failure from the case below (a 2xx
    // response that simply omitted the expected tool-use block).
    const err = new Error("Reasoning model request failed.");
    err.httpStatus = response.status;
    throw err;
  }
  const toolUse = body.content?.find(
    (block) => block?.type === "tool_use" && block?.name === "decide_attention_response",
  );
  if (!toolUse?.input) {
    const err = new Error("Reasoning model returned no structured decision.");
    err.httpStatus = response.status;
    throw err;
  }
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
// Diagnostic-only reason codes (2026-08-29, Turn 4 production diagnostic —
// see api/_carson-read-turn.js's CARSON_STAGE2_DIAGNOSTIC_LOGGING). Purely
// additive: no existing caller reads this field, and .ok truthiness is
// unchanged for every case below — this cannot alter production behavior,
// only make an already-failing decision's failure reason observable in the
// redacted diagnostic log.
export function validateAttentionDecision(decision, authorizedEvidence) {
  if (!decision || typeof decision !== "object") return { ok: false, reason: "not_object" };
  if (!RESPONSE_INTENTS.includes(decision.responseIntent)) return { ok: false, reason: "invalid_response_intent" };
  if (!Array.isArray(decision.selectedEvidenceIds)) return { ok: false, reason: "selected_ids_not_array" };

  const authorizedIds = new Set(collectEvidenceIds(authorizedEvidence));
  for (const id of decision.selectedEvidenceIds) {
    if (typeof id !== "string" || !authorizedIds.has(id)) return { ok: false, reason: "selected_id_unauthorized_or_invalid_type" };
  }

  let rankedEvidenceIds;
  if (decision.rankedEvidenceIds !== undefined && decision.rankedEvidenceIds !== null) {
    if (!Array.isArray(decision.rankedEvidenceIds)) return { ok: false, reason: "ranked_ids_not_array" };
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
    if (!Array.isArray(decision.contrastedEvidenceIds)) return { ok: false, reason: "contrasted_ids_not_array" };
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
    // "list" with zero selected ids is a legitimate, truthful answer to a
    // category-scoped follow-up when that category genuinely has nothing in
    // it right now (e.g. "What about the things I'm waiting on?" when
    // waiting is empty) — renderAttentionDecision already has the correct
    // "Nothing matches that right now." fallback for exactly this shape
    // (see carson-attention-summary.js); this validator was rejecting it
    // before that renderer ever got the chance (2026-09-02 live isolated
    // canary regression).
    decision.responseIntent !== "list" &&
    !(decision.responseIntent === "contrast" && contrastedEvidenceIds?.length > 0)
  ) {
    return { ok: false, reason: "empty_selection_for_intent" };
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
