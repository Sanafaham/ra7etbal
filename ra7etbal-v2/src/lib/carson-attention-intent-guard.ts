/**
 * carson-attention-intent-guard.ts
 *
 * Deterministic, code-level backstop for the general "what needs my
 * attention" question class (attention_summary_read /
 * get_items_needing_attention). Whether the ElevenLabs model actually calls
 * that tool for a given turn remains model/prompt-controlled — this module
 * does not force the call. What it does: detect, from the raw transcript
 * alone, when that question class was asked, and — whenever a fresh
 * get_items_needing_attention-equivalent result is available for this turn
 * — make that live, evidence-only result AUTHORITATIVE, replacing the
 * agent's own separately-generated reply outright. This is the same "prefer
 * the tool's own result over a contradictory agent-generated message"
 * pattern already shipped in carson-direct-tool-override.ts for other
 * tools, but stronger: it applies regardless of whether the model reports
 * having called the tool.
 *
 * Root cause this exists for (2026-08-25 production investigation, two
 * incidents): (1) a separate, code-injected instruction set
 * (CARSON_STATUS_POLICY) and the ElevenLabs dashboard prompt can each
 * independently answer this question class from injected context instead
 * of the tool; (2) even when the tool DID run, the model's own composed
 * reply is a separate generation that can still blend in unrelated,
 * ungrounded content (e.g. a leftover CARSON_STATUS_POLICY worked example)
 * alongside the tool's real evidence — the original version of this guard
 * only substituted when the tool had NOT run, unconditionally trusting the
 * model's reply whenever it had, which left this second path fully open.
 * Grounded evidence is now authoritative whenever it exists, independent of
 * that flag — the model gets no opportunity to add, omit, or reword a
 * factual claim once real evidence has been retrieved for this question
 * class.
 *
 * Known limitation, stated plainly rather than silently accepted: for
 * voice, this can only correct the persisted/displayed transcript, not
 * audio ElevenLabs has already spoken by the time onMessage delivers the
 * agent's turn — the same limitation carson-direct-tool-override.ts already
 * has for its own corrections. For typed, this is a complete fix (typed has
 * no already-spoken-audio problem). A live re-fetch/tool result is only
 * ever used when one was already available for this exact turn (kicked off
 * the instant the matching user utterance arrived, or captured directly
 * from the tool's own return value) and resolved before the agent replied
 * — this module never blocks or delays the agent's reply waiting for one.
 *
 * 2026-08-25 production investigation, third incident: with no grounded
 * result available, this module used to pass the model's reply through
 * unchanged ("safe failure, never fabricates a substitute"). That was
 * itself the hole — a production test showed the model, given no evidence,
 * freely composing its own operational classification ("three overdue
 * tasks... need your immediate attention", then contradictorily "waiting
 * on confirmation..." on the very next turn) for records that were neither
 * overdue nor waiting per the actual classifier. "No evidence" must mean
 * "no factual claim," not "whatever the model says instead." With no
 * grounded result available, this module now returns a fixed, honest,
 * policy-compliant fallback (ATTENTION_GROUNDING_UNAVAILABLE_MESSAGE) —
 * reusing carson-operations-center.ts's own fetchAttentionSummary()
 * total-failure phrasing for consistency — never the model's prose.
 */

// PURE RELOCATION (2026-08-28, Second Brain typed hard-grounding slice):
// matchesAttentionIntent, matchesAttentionFollowUp, and
// ATTENTION_GROUNDING_UNAVAILABLE_MESSAGE moved to shared/ so the
// server-side typed hard-grounding path classifies the exact same way.
// Re-exported here so every existing caller's import path
// (`./carson-attention-intent-guard`) and behavior are unchanged.
import {
  matchesAttentionIntent,
  matchesAttentionFollowUp,
  ATTENTION_GROUNDING_UNAVAILABLE_MESSAGE,
} from "../../shared/carson-attention-intent-classifier.js";
export { matchesAttentionIntent, matchesAttentionFollowUp, ATTENTION_GROUNDING_UNAVAILABLE_MESSAGE };
import type { AttentionCaptureRef, AttentionPresentation, VoiceAttentionRequest } from "./carson-operations-center";

export interface ResolveAttentionGuardedMessageInput {
  /** The agent's own separately-generated reply for this turn. */
  agentMessage: string;
  /**
   * True when this turn's user utterance matched matchesAttentionIntent, or
   * matched matchesAttentionFollowUp immediately after a grounded attention
   * answer.
   */
  attentionIntentDetected: boolean;
  /**
   * A fresh get_items_needing_attention-equivalent result for this exact
   * turn — from the tool's own real return value if it ran, or from the
   * live prefetch kicked off the instant the matching utterance arrived,
   * whichever resolved. Null when neither is available yet — this module
   * never fabricates one and never delays the reply to wait for one.
   */
  groundedResult: string | null;
}

/**
 * Returns the message that should actually be displayed/persisted for this
 * turn. Only ever replaces agentMessage with groundedResult — never
 * modifies, truncates, or rephrases either string.
 *
 * Deliberately does NOT take whether the tool "ran" into account: a model
 * self-report that it called the tool is not proof its reply faithfully
 * reports the tool's evidence. Whenever attention intent was detected and
 * live grounded evidence exists for this turn, that evidence wins
 * unconditionally — the model gets no opportunity to add, omit, or reword a
 * factual claim on top of it. When no grounded evidence exists yet, returns
 * ATTENTION_GROUNDING_UNAVAILABLE_MESSAGE — never agentMessage — so "no
 * evidence" can never become "whatever the model composed instead."
 */
export function resolveAttentionGuardedMessage({
  agentMessage,
  attentionIntentDetected,
  groundedResult,
}: ResolveAttentionGuardedMessageInput): string {
  if (!attentionIntentDetected) return agentMessage;
  if (!groundedResult) return ATTENTION_GROUNDING_UNAVAILABLE_MESSAGE;
  return groundedResult;
}

export interface ResolvePresentedAttentionCaptureIdsInput {
  attentionIntentDetected: boolean;
  /** This turn's grounded attention result (prefetch or tool), or null. */
  grounded: AttentionPresentation | null;
  /** The exact text about to be shown in the owner-visible bubble. */
  displayedMessage: string;
}

/**
 * P3 Step 3 / S2 — RETRIEVED / PREFETCHED ≠ SURFACED TO OWNER. Returns the
 * captures that actually reached the owner-visible bubble this turn: only
 * when the bubble shows the grounded attention text itself. A prefetch or
 * tool result the owner never sees (no grounded result yet, the grounding-
 * unavailable fallback, or a reply rewritten by a later guard) returns [],
 * so nothing is marked surfaced.
 */
export function resolvePresentedAttentionCaptureIds({
  attentionIntentDetected,
  grounded,
  displayedMessage,
}: ResolvePresentedAttentionCaptureIdsInput): AttentionCaptureRef[] {
  if (!attentionIntentDetected || !grounded) return [];
  if (displayedMessage !== grounded.text) return [];
  return grounded.captureIds;
}

// P3 Step 3 / S3 — legacy voice follow-ups that ask for the items themselves.
// Only meaningful straight after an attention answer (the caller gates on
// that), exactly like matchesAttentionFollowUp. Voice-only: typed is unchanged.
// "Which ones?" asks for every item; "Tell me the rest" / "What else?" /
// "Continue" ask for the items the last answer did not name (2026-10-09
// canary: after Christopher's items, "Tell me the rest" meant the others).
const VOICE_ATTENTION_ALL_FOLLOWUP_PATTERN =
  /^\s*(?:(?:and|so|ok(?:ay)?)[,\s]+)?(?:which ones|what are they|list them(?: all)?|name them(?: all)?|is that everything)\s*[?.!]*\s*$/i;
const VOICE_ATTENTION_REST_FOLLOWUP_PATTERN =
  /^\s*(?:(?:and|so|ok(?:ay)?)[,\s]+)?(?:tell me the rest(?: of them)?|what(?:'s| is| are) the rest(?: of them)?|the rest(?: of them)?|what else(?: is pending)?|anything else|continue|keep going|go on)\s*[?.!]*\s*$/i;
const VOICE_ATTENTION_PERSON_FOLLOWUP_PATTERN =
  /^\s*(?:(?:and|so)[,\s]+)?(?:what about|how about|and)\s+([\p{L}][\p{L}\p{M}' -]{0,40}?)\s*[?.!]*\s*$/iu;

/**
 * P3 Step 3 / S3 — what a legacy voice follow-up to an attention answer is
 * asking for, or null when it is not one. "Which ones?" asks for every open
 * item; "Tell me the rest" / "What else?" / "Continue" for the items the last
 * answer did not name (the caller supplies which); "What about Christopher?" asks
 * for one person, but only when that person had an open item in the last
 * live voice attention answer (lastAssignees), matched by full name or by an
 * unambiguous first name, so "What about dinner?" is never taken over. The
 * answer itself is always re-read live.
 */
export function resolveVoiceAttentionFollowUp(
  utterance: string,
  lastAssignees: readonly string[],
): VoiceAttentionRequest | null {
  const text = utterance.replace(/[\u2018\u2019]/g, "'");
  if (VOICE_ATTENTION_ALL_FOLLOWUP_PATTERN.test(text)) return { kind: "all" };
  if (VOICE_ATTENTION_REST_FOLLOWUP_PATTERN.test(text) || matchesAttentionFollowUp(text)) return { kind: "rest" };
  const person = VOICE_ATTENTION_PERSON_FOLLOWUP_PATTERN.exec(text)?.[1]?.trim().toLowerCase();
  if (!person) return null;
  const byFirstName = lastAssignees.filter((assignee) => assignee.trim().toLowerCase().split(/\s+/)[0] === person);
  const exact = lastAssignees.find((assignee) => assignee.trim().toLowerCase() === person);
  // Ambiguous ("Christopher" and "Christopher Smith" both open): no guess,
  // because a person view of one would silently leave out the other.
  if (exact) return byFirstName.length <= 1 ? { kind: "person", name: exact } : null;
  return byFirstName.length === 1 ? { kind: "person", name: byFirstName[0] } : null;
}
