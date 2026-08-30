/**
 * _carson-tool-execution-result.js
 *
 * C-03 Structural Response Ownership Project — Slice 2.
 *
 * The shared structured contracts (ToolExecutionResult, FinalCarsonResponse)
 * and the C-03 truth-validation logic that turns a tool's real outcome into
 * the ONE final response text that gets spoken, displayed, and stored.
 *
 * Nothing in this file executes a tool or calls a model — it is pure
 * transformation logic, fully unit-testable offline.
 */

import { getToolDefinition } from "./_carson-tool-definitions.js";

/**
 * @typedef {"success"|"failure"|"partial"|"uncertain"} ExecutionOutcome
 *
 * @typedef {object} ToolExecutionResult
 * @property {string} tool_name
 * @property {string} text - the raw text the tool returned (natural language today).
 * @property {ExecutionOutcome} outcome
 * @property {"natural"|"exact"} response_mode
 * @property {Record<string, unknown>} [verified_facts]
 */

/**
 * @typedef {object} FinalCarsonResponse
 * @property {string} text
 * @property {"natural"|"exact"} response_mode
 * @property {{tool_name: string, outcome: ExecutionOutcome, verified_facts?: Record<string, unknown>}} [execution_status]
 * @property {string} turn_id
 */

// C-03's explicit no-upgrade pairs. A candidate final-response draft must
// never assert the "stronger" side when the verified outcome is the weaker one.
const NO_UPGRADE_PAIRS = [
  ["failure", /\b(done|completed|finished|success(ful)?|all set|handled)\b/i],
  ["uncertain", /\b(confirmed|verified|done|completed)\b/i],
  ["partial", /\ball (done|sent|handled|set)\b/i],
];

// The reverse direction: a verified SUCCESS must never be reported as a
// failure/uncertainty either (owner's Case B failure-injection requirement —
// this is not an "upgrade," it's a false negative, and is just as much a
// truthfulness violation).
const FAILURE_LANGUAGE_ON_VERIFIED_SUCCESS =
  /\b(wasn'?t able|couldn'?t|unable to|failed to|didn'?t work|not able to|can'?t (?:do|complete))\b/i;

/**
 * Builds a ToolExecutionResult from a raw client-tool return value plus the
 * tool's own classification (see _carson-tool-definitions.js). This is where
 * "do not infer success from a natural-language string" is enforced: an
 * unclassified or "uncertain" tool NEVER gets upgraded to success/failure
 * here, regardless of what the returned text sounds like.
 *
 * @param {{toolName: string, rawText: string, deterministicOutcome?: ExecutionOutcome, verifiedFacts?: Record<string, unknown>, exact?: boolean}} input
 * @returns {ToolExecutionResult}
 */
export function buildToolExecutionResult({
  toolName,
  rawText,
  deterministicOutcome,
  verifiedFacts,
  exact = false,
}) {
  const definition = getToolDefinition(toolName);
  const canBeExact = Boolean(definition?.canBeExact);

  // Exactness must be declared by the specific result instance, never
  // inferred from the tool's category or the text's shape (C-03, C-05 review).
  const responseMode = exact && canBeExact ? "exact" : "natural";

  const outcome =
    deterministicOutcome && ["success", "failure", "partial"].includes(deterministicOutcome)
      ? deterministicOutcome
      : "uncertain";

  return {
    tool_name: toolName,
    text: typeof rawText === "string" ? rawText : "",
    outcome,
    response_mode: responseMode,
    verified_facts: verifiedFacts ?? {},
  };
}

/**
 * C-03 truth validation: rejects a candidate natural-language draft that
 * upgrades the verified outcome to something stronger. Returns the
 * (possibly replaced) safe text — never the disallowed draft.
 *
 * @param {ToolExecutionResult} toolResult
 * @param {string} candidateDraft - the reasoning model's proposed sentence.
 * @returns {{text: string, wasRejected: boolean, reason?: string}}
 */
export function enforceNoSemanticUpgrade(toolResult, candidateDraft) {
  const draft = typeof candidateDraft === "string" ? candidateDraft : "";

  if (toolResult.outcome === "success" && FAILURE_LANGUAGE_ON_VERIFIED_SUCCESS.test(draft)) {
    return {
      text: toolResult.text || draft,
      wasRejected: true,
      reason: 'draft asserted failure/uncertainty against a verified "success" outcome',
    };
  }

  for (const [outcome, pattern] of NO_UPGRADE_PAIRS) {
    if (toolResult.outcome === outcome && pattern.test(draft)) {
      return {
        text: toolResult.text || conservativeFallback(toolResult.outcome),
        wasRejected: true,
        reason: `draft asserted a stronger outcome than verified "${toolResult.outcome}"`,
      };
    }
  }
  return { text: draft || toolResult.text, wasRejected: false };
}

function conservativeFallback(outcome) {
  switch (outcome) {
    case "failure":
      return "That didn't complete. Please try again.";
    case "uncertain":
      return "I couldn't confirm that completed. Please try again.";
    case "partial":
      return "That only partly completed.";
    default:
      return "";
  }
}

/**
 * Produces the ONE FinalCarsonResponse for a turn that followed a tool call.
 * This is the single point where text is decided — nothing downstream may
 * regenerate it for voice vs. display vs. history.
 *
 * @param {{toolResult: ToolExecutionResult, candidateDraft: string, turnId: string}} input
 * @returns {FinalCarsonResponse}
 */
export function finalizeCarsonResponse({ toolResult, candidateDraft, turnId }) {
  if (toolResult.response_mode === "exact") {
    // Exact-output: no LLM rewrite, no sanitizer, no override — the
    // capability's own text is the final response, verbatim.
    return {
      text: toolResult.text,
      response_mode: "exact",
      execution_status: {
        tool_name: toolResult.tool_name,
        outcome: toolResult.outcome,
        verified_facts: toolResult.verified_facts,
      },
      turn_id: turnId,
    };
  }

  const { text } = enforceNoSemanticUpgrade(toolResult, candidateDraft);
  return {
    text,
    response_mode: "natural",
    execution_status: {
      tool_name: toolResult.tool_name,
      outcome: toolResult.outcome,
      verified_facts: toolResult.verified_facts,
    },
    turn_id: turnId,
  };
}

/**
 * Produces a FinalCarsonResponse for an ordinary (non-tool) conversational
 * turn — no execution_status, natural mode, the model's draft passes through
 * unchanged (there is no verified result to validate against).
 *
 * @param {{text: string, turnId: string}} input
 * @returns {FinalCarsonResponse}
 */
export function finalizeOrdinaryResponse({ text, turnId }) {
  return { text: typeof text === "string" ? text : "", response_mode: "natural", turn_id: turnId };
}
