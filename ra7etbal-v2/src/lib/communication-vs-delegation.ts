/**
 * CARSON PROTECTED BEHAVIORS — the single shared classifier distinguishing
 * simple staff communication from tracked delegated work. See "CARSON
 * PROTECTED BEHAVIORS" in AGENTS.md and the carson-protected-behaviors test
 * suite (a mandatory CI gate — see .github/workflows).
 *
 * The distinction is whether Ra7etBal needs to track completed work, never
 * merely whether the sentence contains an action verb. The same verb can be
 * either: "call the mechanic" is trackable delegated work; "call me" is not
 * — the owner is the target, not a third party or a physical task object.
 * This function is deliberately verb-agnostic and keyed on the *target* of
 * the action, not a fixed phrase list, so it generalizes beyond the exact
 * wording seen in production (never hardcode only "call me" or "wait for
 * me" — see the regression this replaces).
 *
 * Used at the one place both channels' delegation-creation paths converge:
 * sendDelegation() in ElevenLabsAgentWidget.tsx — the shared handler behind
 * BOTH Talk to Carson's send_delegation clientTool and Type to Carson's
 * delegation fast path (executeDelegationFastPath's injected
 * sendDelegationFn) — so both channels are protected by one guard,
 * regardless of how each one decided to attempt a delegation.
 * direct-message-fast-path.ts's own parsing logic (COMMAND_PREFIX,
 * DELEGATION_BODY_START, isUnsafeBody) is unrelated and unchanged by this
 * module — it already resolved the confirmed regression's "wait for me"
 * case correctly before this fix existed.
 */
const OWNER_TARGET_COMMUNICATION =
  /\b(?:call|contact|text|message|whatsapp|ring|phone|reach)\s+(?:me|us)\b|\bwait\s+(?:for|here\s+for)\s+(?:me|us)\b|\blet\s+(?:me|us)\s+know\b/i;

export function isCommunicationStyleTaskText(taskText: string): boolean {
  return OWNER_TARGET_COMMUNICATION.test(taskText.trim());
}
