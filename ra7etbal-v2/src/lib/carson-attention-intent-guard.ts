/**
 * carson-attention-intent-guard.ts
 *
 * Deterministic, code-level backstop for the general "what needs my
 * attention" question class (attention_summary_read /
 * get_items_needing_attention). Whether the ElevenLabs model actually calls
 * that tool for a given turn remains model/prompt-controlled — this module
 * does not force the call. What it does: detect, from the raw transcript
 * alone, when that question class was asked and the tool did NOT run, and
 * (when a fresh get_items_needing_attention-equivalent result is already
 * available) substitute the agent's own separately-generated, ungrounded
 * reply with that live, evidence-only result before it is displayed —
 * exactly the same "prefer the tool's own result over a contradictory
 * agent-generated message" pattern already established and shipped in
 * carson-direct-tool-override.ts for other tools.
 *
 * Root cause this exists for (2026-08-25 production investigation): a
 * separate, code-injected instruction set (CARSON_STATUS_POLICY) and the
 * ElevenLabs dashboard prompt can each independently answer this question
 * class from injected context instead of the tool, and the two prompt
 * surfaces are not guaranteed to stay in sync. This guard is a second,
 * independent line of defense that does not depend on either prompt text
 * being correct.
 *
 * Known limitation, stated plainly rather than silently accepted: for
 * voice, this can only correct the persisted/displayed transcript, not
 * audio ElevenLabs has already spoken by the time onMessage delivers the
 * agent's turn — the same limitation carson-direct-tool-override.ts already
 * has for its own corrections. For typed, this is a complete fix (typed has
 * no already-spoken-audio problem). A live re-fetch is only ever used when
 * one was already in flight for this exact turn (kicked off the instant the
 * matching user utterance arrived) and resolved before the agent replied —
 * this module never blocks or delays the agent's reply waiting for one.
 */

// Matches the exact trigger phrases ATTENTION SUMMARY / DAILY BRIEF AND
// STATUS already define, plus the close variants named in the 2026-08-25
// investigation ("what's on my plate", "am I clear").
const ATTENTION_INTENT_PATTERN =
  /\b(?:what needs my attention|what('?s| is) pending|what am i waiting on|what('?s| is) on my plate|am i clear|what('?s| is) outstanding|anything pending)\b/i;

// Only meaningful as a continuation of an attention exchange — the caller
// gates this on the immediately preceding turn having been a grounded
// attention answer (matchesAttentionIntent or a prior matchesAttentionFollowUp
// that resolved grounded). Never treated as attention-scoped on its own.
const ATTENTION_FOLLOWUP_PATTERN =
  /^\s*(?:what else|anything else|is that everything|what else is pending)\s*\??\s*$/i;

export function matchesAttentionIntent(utterance: string): boolean {
  return ATTENTION_INTENT_PATTERN.test(utterance);
}

export function matchesAttentionFollowUp(utterance: string): boolean {
  return ATTENTION_FOLLOWUP_PATTERN.test(utterance);
}

export interface ResolveAttentionGuardedMessageInput {
  /** The agent's own separately-generated reply for this turn. */
  agentMessage: string;
  /**
   * True when this turn's user utterance matched matchesAttentionIntent, or
   * matched matchesAttentionFollowUp immediately after a grounded attention
   * answer.
   */
  attentionIntentDetected: boolean;
  /** True when get_items_needing_attention actually ran for this turn. */
  attentionToolRan: boolean;
  /**
   * A fresh get_items_needing_attention-equivalent result for this exact
   * turn, if one finished resolving before the agent replied. Null when
   * none is available yet — this module never fabricates one and never
   * delays the reply to wait for it.
   */
  groundedResult: string | null;
}

/**
 * Returns the message that should actually be displayed/persisted for this
 * turn. Only ever replaces agentMessage with groundedResult — never
 * modifies, truncates, or rephrases either string.
 */
export function resolveAttentionGuardedMessage({
  agentMessage,
  attentionIntentDetected,
  attentionToolRan,
  groundedResult,
}: ResolveAttentionGuardedMessageInput): string {
  if (!attentionIntentDetected) return agentMessage;
  // The tool ran for this turn — trust the model's reply; it had the real
  // evidence available when it composed this message.
  if (attentionToolRan) return agentMessage;
  if (!groundedResult) return agentMessage;
  return groundedResult;
}
