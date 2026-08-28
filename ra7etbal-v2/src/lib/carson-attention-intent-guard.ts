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
