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

/**
 * Confirmed production regression (2026-07-29): "Ask Christopher to reply
 * 'test received'." produced the spoken reply "Message sent to Christopher."
 * with zero `messages` row, zero `whatsapp_deliveries` row, and zero
 * `/api/send-whatsapp-task` request — send_direct_whatsapp_message was never
 * invoked at all this turn. This is the exact "no tool ran at all" gap this
 * module's own top-of-file comment already documents for save_note (the
 * 2026-07-13 P0): the override above only corrects a contradiction against a
 * tool call that DID run. Mirrors detectsUnconfirmedNoteSaveClaim /
 * noteSaveOutcomeRef exactly rather than reusing lastDirectToolSuccessRef's
 * shared 15s-window override — CodeRabbit already flagged that a shared
 * window lets an earlier turn's unrelated success suppress this fabrication
 * check for a later turn within that same window.
 */
export interface DirectMessageSendOutcome {
  outcome: "success" | "failure";
  resultText: string;
  at: string;
}

const DIRECT_MESSAGE_REQUEST_PATTERN = /\b(?:tell|message|text|whatsapp|ask)\s+[A-Za-z]+\b/i;

// Confirmed production retest (2026-07-29, same day as the fix): "Sent to
// Christopher." — a shorter paraphrase of the original "Message sent to
// Christopher." incident — did not match the pattern below, so the guard
// never fired a second time. Broadened with a "sent [it/that/the message]
// to <Name>" alternative to close this specific paraphrase without widening
// the net to ordinary unrelated uses of "sent" — NEGATED_SEND_PATTERN below
// still excludes any negated/failure phrasing of the same shape.
const MESSAGE_SEND_CONFIRMATION_PATTERN =
  /\b(?:message|text|whatsapp)\s+(?:has\s+been\s+|was\s+)?sent\b|\bsent\s+(?:the\s+|that\s+|your\s+)?message\b|\bi(?:'|’)ve\s+sent\b|\bit(?:'|’)s\s+with\s+[A-Z][a-z]+\b|\bthat(?:'|’)s\s+(?:been\s+)?sent\b|\bsent\s+(?:it\s+|that\s+|the\s+message\s+)?to\s+[A-Z][a-z]+\b/i;

// Excludes a truthful negated/failure phrasing of the exact same "sent"
// shape ("I couldn't get that sent to Christopher.", "It wasn't sent.") from
// being misread as a completion claim.
const NEGATED_SEND_PATTERN =
  /\b(?:wasn|isn|didn|couldn|can|won)['’]?t\s+(?:able\s+to\s+)?(?:get\s+)?(?:it\s+|that\s+|the\s+message\s+)?sen[dt]\b|\bnot\s+sent\b|\bnever\s+sent\b|\bfailed\s+to\s+send\b/i;

/**
 * True when the previous owner message reads as an explicit send/tell/ask
 * request to a named person, the agent's reply claims that message was sent,
 * and send_direct_whatsapp_message did not verifiably succeed THIS turn —
 * i.e. Carson is about to (or did) narrate a delivery that never happened.
 */
export function detectsUnconfirmedMessageSendClaim(
  agentMessage: string,
  previousUserMessage: string,
  messageSendOutcome: DirectMessageSendOutcome | null,
): boolean {
  if (!DIRECT_MESSAGE_REQUEST_PATTERN.test(previousUserMessage)) return false;
  if (!MESSAGE_SEND_CONFIRMATION_PATTERN.test(agentMessage)) return false;
  if (NEGATED_SEND_PATTERN.test(agentMessage)) return false;
  return messageSendOutcome?.outcome !== "success";
}

// Confirmed production incident (2026-07-30, ~03:03 Turkey time): a genuine
// voice call to send_direct_whatsapp_message succeeded (handler_success
// confirmed, Christopher received the WhatsApp) but Carson spoke and
// displayed "I wasn't able to send that. Please try again." — with zero
// claim_overridden diagnostic for the turn, proving this was the agent's own
// original, uncorrected reply, not a client-side correction. Every prior
// truthfulness fix in this file (PR #106/#108/#118) only ever checked for a
// FALSE SUCCESS claim — nothing checked the opposite direction: a false
// FAILURE claim on a send that actually succeeded. This is the symmetric
// counterpart to detectsUnconfirmedMessageSendClaim.
const FAILURE_CLAIM_PATTERN =
  /\b(?:i\s+)?wasn['’]?t\s+able\s+to\s+send\b|\bcouldn['’]?t\s+send\b|\bunable\s+to\s+send\b|\bfailed\s+to\s+send\b|\bdidn['’]?t\s+send\b|\bnot\s+able\s+to\s+send\b/i;

/**
 * True when the previous owner message reads as an explicit send/tell/ask
 * request to a named person, the agent's reply falsely claims the send
 * failed (or is uncertain), and send_direct_whatsapp_message actually
 * verifiably succeeded THIS turn — i.e. Carson is about to (or did) narrate
 * a failure that never happened.
 */
export function detectsUnconfirmedMessageSendFailureClaim(
  agentMessage: string,
  previousUserMessage: string,
  messageSendOutcome: DirectMessageSendOutcome | null,
): boolean {
  if (!DIRECT_MESSAGE_REQUEST_PATTERN.test(previousUserMessage)) return false;
  if (!FAILURE_CLAIM_PATTERN.test(agentMessage)) return false;
  return messageSendOutcome?.outcome === "success";
}

/**
 * Pattern-match only (ignores the actual outcome) — true whenever the
 * agent's reply makes ANY claim, success or failure, about a message-send
 * request. Used by the client to decide whether to defer and await the
 * tool's own in-flight settle before finalizing what's displayed, since
 * either direction of claim can turn out to be false while the real result
 * is still resolving.
 */
export function looksLikeMessageSendOutcomeClaim(
  agentMessage: string,
  previousUserMessage: string,
): boolean {
  if (!DIRECT_MESSAGE_REQUEST_PATTERN.test(previousUserMessage)) return false;
  return (
    (MESSAGE_SEND_CONFIRMATION_PATTERN.test(agentMessage) && !NEGATED_SEND_PATTERN.test(agentMessage)) ||
    FAILURE_CLAIM_PATTERN.test(agentMessage)
  );
}

// Confirmed production incident (2026-07-29, ~18:39 and ~20:19 Turkey time):
// a genuine voice call to send_direct_whatsapp_message succeeded — Christopher
// received the WhatsApp message — yet the displayed transcript still showed
// the honest-sounding "I couldn't confirm that message actually sent." fallback.
// carson_tool_diagnostics traced the exact cause: the agent's own separately-
// generated reply (this file's own top-of-file doc comment already explains
// this is a distinct generation from the tool's return value) arrived and was
// classified ~35ms BEFORE the tool's own handler_success diagnostic — i.e.
// while the real WhatsApp send was still in flight over the network (a ~2.3s
// round trip in the confirmed incident). Reading a still-null outcome ref at
// that exact instant and immediately concluding "not confirmed" cannot tell
// "genuinely failed/never called" apart from "still resolving" — both look
// identical to a synchronous snapshot. This resolves that ambiguity: when a
// tool call is still in flight for this exact turn, wait for its own
// authoritative settle before finalizing the classification, instead of
// treating "not yet known" the same as "confirmed not successful". Bounded by
// a generous timeout so a genuine hang still falls back to the honest
// "unconfirmed" reply rather than leaving the turn unresolved forever.
export const MESSAGE_SEND_AWAIT_TIMEOUT_MS = 12_000;

export async function resolvePendingMessageSendOutcome(
  pendingOutcome: Promise<DirectMessageSendOutcome | null> | null,
  timeoutMs: number = MESSAGE_SEND_AWAIT_TIMEOUT_MS,
): Promise<DirectMessageSendOutcome | null> {
  if (!pendingOutcome) return null;
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([pendingOutcome, timeout]);
  } catch {
    // The tool's own promise chain never rejects in practice (every real
    // failure is caught and recorded as outcome: "failure"), but never let an
    // unexpected rejection here surface as an unhandled error — treat it the
    // same as "still unknown", which correctly falls back to the honest
    // unconfirmed reply.
    return null;
  }
}

interface ResolveSanitizedCarsonDisplayMessageInput {
  agentMessage: string;
  previousUserMessage?: string;
  lastSuccess: DirectToolSuccessResult | null;
  noteSaveOutcome?: NoteSaveOutcome | null;
  messageSendOutcome?: DirectMessageSendOutcome | null;
  now?: number;
}

const UNCONFIRMED_NOTE_SAVE_REPLY =
  "I couldn't confirm that was saved. Please say it again so I can save it properly.";

const UNCONFIRMED_MESSAGE_SEND_REPLY =
  "I couldn't confirm that message actually sent. Please ask me to try again.";

export function resolveSanitizedCarsonDisplayMessage({
  agentMessage,
  previousUserMessage = "",
  lastSuccess,
  noteSaveOutcome = null,
  messageSendOutcome = null,
  now = Date.now(),
}: ResolveSanitizedCarsonDisplayMessageInput): string {
  if (detectsUnconfirmedNoteSaveClaim(agentMessage, previousUserMessage, noteSaveOutcome)) {
    return sanitizeCarsonReplyText(UNCONFIRMED_NOTE_SAVE_REPLY);
  }
  if (detectsUnconfirmedMessageSendClaim(agentMessage, previousUserMessage, messageSendOutcome)) {
    return sanitizeCarsonReplyText(UNCONFIRMED_MESSAGE_SEND_REPLY);
  }
  // Symmetric case (confirmed 2026-07-30 incident): the agent falsely claimed
  // the send FAILED while the tool actually confirmed success — use the
  // tool's own true result text, never the agent's false failure claim.
  if (detectsUnconfirmedMessageSendFailureClaim(agentMessage, previousUserMessage, messageSendOutcome)) {
    return sanitizeCarsonReplyText(messageSendOutcome!.resultText);
  }

  const toolAwareMessage = resolveCarsonDisplayMessage(agentMessage, lastSuccess, now);
  return sanitizeCarsonReplyText(
    isSocialAcknowledgement(previousUserMessage)
      ? sanitizeSocialAcknowledgementReply(toolAwareMessage)
      : toolAwareMessage,
  );
}

// ── Typed advisory-only truthfulness guard (2026-07-25 product decision) ────
// Every state-changing client tool is already blocked for typed mode (see
// TYPED_BLOCKED_TOOL_MESSAGES in ElevenLabsAgentWidget.tsx) — no real
// delegation, reminder, or message send can happen. But the free-form typed
// model generates its own natural-language reply independently of any tool
// call, and a confirmed production bug showed it can fabricate a false
// execution promise ("I'll have Grace handle it.") for a request no tool was
// ever invoked for. Blocking tool calls cannot catch this — it is a pure
// wording problem, caught here deterministically on the displayed text
// itself, applied ONLY to the typed channel by its one call site in
// ElevenLabsAgentWidget.tsx. Voice is untouched — the exact same phrasing is
// truthful for voice, which really does execute.
// CodeRabbit finding: the free-form model can phrase the same promise
// uncontracted ("I will..." instead of "I'll..."), so each alternative
// matches both forms rather than only the apostrophe contraction.
const TYPED_FUTURE_RE = /(?:I(?:'|’)ll|I\s+will)/;
const TYPED_FALSE_PROMISE_PATTERN = new RegExp(
  `\\b${TYPED_FUTURE_RE.source}\\s+have\\s+[A-Z][a-zA-Z'-]*\\s+handle\\s+(?:it|this|that)\\b` +
    `|\\b${TYPED_FUTURE_RE.source}\\s+take\\s+care\\s+of\\s+(?:it|this|that)\\b` +
    `|\\b${TYPED_FUTURE_RE.source}\\s+remind\\s+you\\b` +
    `|\\b${TYPED_FUTURE_RE.source}\\s+send\\s+(?:it|this|that)\\b` +
    `|\\b${TYPED_FUTURE_RE.source}\\s+assign\\s+(?:it|this|that)\\b` +
    `|\\b${TYPED_FUTURE_RE.source}\\s+add\\s+(?:it|this|that)\\b` +
    `|\\bit(?:'|’)s\\s+done\\b`,
  "i",
);

const TYPED_ADVISORY_FALLBACK_REPLY =
  "I can help you prepare that, but I can't complete it from typed chat. Use Talk to Carson to do it.";

/**
 * Typed-only. Replaces a reply that falsely claims a state-changing action
 * was (or will be) performed with a truthful advisory + redirect message.
 * Never called for voice, where the same claim can be genuinely true.
 *
 * A reply that already mentions Talk to Carson is left untouched even if it
 * also matches the pattern below — the confirmed bug reply never mentioned
 * Talk to Carson at all ("For the electricity bill, I'll have Grace handle
 * it."), while a correctly-hedged advisory reply naturally does ("I'll remind
 * you that Talk to Carson is the only way to actually create it."). This
 * avoids discarding an already-truthful reply's real content.
 */
export function sanitizeTypedAdvisoryReply(message: string): string {
  if (/Talk to Carson/i.test(message)) return message;
  return TYPED_FALSE_PROMISE_PATTERN.test(message) ? TYPED_ADVISORY_FALLBACK_REPLY : message;
}
