/**
 * carson-direct-tool-override.ts
 *
 * The ElevenLabs agent's spoken/displayed reply (onMessage role:"agent") is a
 * separate LLM generation from our client tool's return value — it can
 * contradict a tool that just succeeded (see create_todo P0: tool returned
 * "Added to your to-do list." while the agent said "I wasn't able to save
 * that."). This module decides when to prefer the tool's own success result
 * over a contradictory agent message, for a short window after the tool ran.
 */

import {
  isSocialAcknowledgement,
  sanitizeCarsonReplyText,
  sanitizeSocialAcknowledgementReply,
} from "./carson-social";

export interface DirectToolSuccessResult {
  toolName: string;
  resultText: string;
  at: string;
  inputSummary?: unknown;
  /**
   * "success" (default, for backward compatibility with every call site that
   * predates this field) or "failure". A tool records "failure" only at its
   * own verified failure return points (hard-blocks, non-2xx responses,
   * unconfirmed persistence) — never a guess. This lets the override system
   * correct the opposite direction from what it originally shipped for: the
   * agent's own separately-generated spoken reply claiming success when the
   * tool call is known to have failed.
   */
  outcome?: "success" | "failure";
}

const OVERRIDABLE_TOOL_NAMES = new Set([
  "create_todo",
  "complete_todo",
  "create_reminder",
  "create_automation",
  "execute_instruction",
  "control_task",
  "send_delegation",
  "save_note",
]);

const OVERRIDE_WINDOW_MS = 15_000;

// Production bug (2026-07-13): Carson replied "Saved." to an explicit note
// request ("Note that I would like to make call Carson feature...") with no
// corresponding carson_notes row ever created — no save_note tool call
// succeeded (or ran at all) that turn, yet the agent's own separately
// generated reply still claimed success. The override above only corrects a
// contradiction against a tool call that DID run; it does nothing when no
// tool ran at all. This pattern set is intentionally broader than (and
// separate from) note-routing.ts's hasExplicitNoteIntent, which classifies
// Clear My Head extraction items — this one only gates a safety-net
// truthfulness check, not what gets created.
const EXPLICIT_NOTE_REQUEST_PATTERN =
  /\bnote\s+(?:that|to\s+\w+)\b|\bplease\s+note\b|\bmake\s+a\s+note\b|\bsave\s+(?:this|that)\s+(?:note|idea|thought)\b|\bremember\s+this\s+(?:idea|thought|information)\b|\bhold\s+this\s+thought\b|\badd\s+this\s+to\s+(?:my\s+)?notes\b/i;

const NOTE_SAVE_CONFIRMATION_PATTERN =
  /\b(?:saved|noted|added\s+(?:that|it)?\s*to\s+your\s+notes)\b/i;

const FAILURE_LANGUAGE_PATTERN =
  /wasn['’]?t able|couldn['’]?t complete|don['’]?t have (?:the )?ability|cannot directly|can['’]?t directly|directly close|try again|technical issue|\bsupport\b/i;

const GENERIC_KNOWLEDGE_ANSWER_PATTERN =
  /as for your question|to answer your question|your question|question about|sounds like a question|in general|generally speaking|here(?:'|’)s (?:what|how|why)|the answer is|provide financial protection|insurance compan(?:y|ies|ies')|insurance providers/i;

const REMINDER_CONFIRMATION_PATTERN =
  /\b(?:i(?:'|’)ll remind you|reminder (?:created|set|saved)|created (?:the )?reminder|set (?:the )?reminder)\b/i;

// Only used on the failure-outcome side, to distinguish a fabricated success
// claim from a neutral follow-up ("Anything else?", "What would you like me
// to do next?"). "Doesn't sound like failure" is too broad a net — a neutral
// message also doesn't sound like failure, but overriding it with stale
// failure text would itself be an untruthful, out-of-context correction.
const SUCCESS_LANGUAGE_PATTERN =
  /\b(?:i(?:'|’)ve|i(?:'|’)ll|i have|done\b|all set|set up|created|added|scheduled|that(?:'|’)s (?:taken care of|handled|set)|got that (?:running|set|done)|reminder (?:created|set|saved))\b/i;

function shouldOverrideAgentMessage(
  agentMessage: string,
  lastSuccess: DirectToolSuccessResult,
): boolean {
  if (lastSuccess.outcome === "failure") {
    // The tool call is verified to have failed. Only override when the
    // agent's own message positively reads as a completion/success claim —
    // never on the mere absence of failure language, which would also
    // wrongly catch neutral follow-ups unrelated to the failed action. If
    // the agent's message already sounds like a failure, leave it; it's
    // already truthful.
    return (
      SUCCESS_LANGUAGE_PATTERN.test(agentMessage) &&
      !FAILURE_LANGUAGE_PATTERN.test(agentMessage)
    );
  }

  if (
    lastSuccess.toolName === "execute_instruction" &&
    isDelegationCoveragePartialSuccess(lastSuccess.inputSummary)
  ) {
    return true;
  }

  if (FAILURE_LANGUAGE_PATTERN.test(agentMessage)) return true;

  if (lastSuccess.toolName !== "create_reminder") return false;
  if (REMINDER_CONFIRMATION_PATTERN.test(agentMessage)) return false;

  return GENERIC_KNOWLEDGE_ANSWER_PATTERN.test(agentMessage);
}

function isDelegationCoveragePartialSuccess(inputSummary: unknown): boolean {
  return (
    typeof inputSummary === "object" &&
    inputSummary !== null &&
    "kind" in inputSummary &&
    inputSummary.kind === "delegation_coverage_partial_success"
  );
}

export function resolveCarsonDisplayMessage(
  agentMessage: string,
  lastSuccess: DirectToolSuccessResult | null,
  now: number = Date.now(),
): string {
  if (!lastSuccess) return agentMessage;
  if (!OVERRIDABLE_TOOL_NAMES.has(lastSuccess.toolName)) return agentMessage;
  if (!shouldOverrideAgentMessage(agentMessage, lastSuccess)) return agentMessage;

  const successAt = Date.parse(lastSuccess.at);
  if (Number.isNaN(successAt) || now - successAt > OVERRIDE_WINDOW_MS) {
    return agentMessage;
  }

  return lastSuccess.resultText;
}

/**
 * save_note's outcome for the CURRENT user turn only. Deliberately NOT a
 * DirectToolSuccessResult / time-window check: CodeRabbit correctly flagged
 * that a shared 15-second window would let an unrelated tool's (or an
 * earlier turn's) success suppress the fabrication check for a LATER note
 * request inside that same window. The caller is responsible for resetting
 * this to null at every new-turn boundary (voice: a fresh transcript
 * arrives; typed: a message is submitted) — see noteSaveOutcomeRef in
 * ElevenLabsAgentWidget.tsx.
 */
export interface NoteSaveOutcome {
  outcome: "success" | "failure";
  resultText: string;
  at: string;
}

/**
 * True when the previous owner message reads as an explicit note-saving
 * request, the agent's reply claims that request was saved, and save_note
 * did not verifiably succeed THIS turn — i.e. Carson is about to (or did)
 * narrate a save that never happened.
 */
export function detectsUnconfirmedNoteSaveClaim(
  agentMessage: string,
  previousUserMessage: string,
  noteSaveOutcome: NoteSaveOutcome | null,
): boolean {
  if (!EXPLICIT_NOTE_REQUEST_PATTERN.test(previousUserMessage)) return false;
  if (!NOTE_SAVE_CONFIRMATION_PATTERN.test(agentMessage)) return false;
  return noteSaveOutcome?.outcome !== "success";
}

interface ResolveSanitizedCarsonDisplayMessageInput {
  agentMessage: string;
  previousUserMessage?: string;
  lastSuccess: DirectToolSuccessResult | null;
  noteSaveOutcome?: NoteSaveOutcome | null;
  now?: number;
}

const UNCONFIRMED_NOTE_SAVE_REPLY =
  "I couldn't confirm that was saved. Please say it again so I can save it properly.";

export function resolveSanitizedCarsonDisplayMessage({
  agentMessage,
  previousUserMessage = "",
  lastSuccess,
  noteSaveOutcome = null,
  now = Date.now(),
}: ResolveSanitizedCarsonDisplayMessageInput): string {
  if (detectsUnconfirmedNoteSaveClaim(agentMessage, previousUserMessage, noteSaveOutcome)) {
    return sanitizeCarsonReplyText(UNCONFIRMED_NOTE_SAVE_REPLY);
  }

  const toolAwareMessage = resolveCarsonDisplayMessage(agentMessage, lastSuccess, now);
  return sanitizeCarsonReplyText(
    isSocialAcknowledgement(previousUserMessage)
      ? sanitizeSocialAcknowledgementReply(toolAwareMessage)
      : toolAwareMessage,
  );
}
