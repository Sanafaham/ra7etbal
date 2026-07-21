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
// "wait" allows one short location clause between "wait" and "for me/us" —
// "wait IN THE KITCHEN for me" is still communication, not a different
// instruction. "in"/"at"/"by"/"near" require 1-3 following words (they
// can't stand alone — "wait in for me" isn't a location); "outside"/
// "inside" allow 0-3 (they're adverbs that can stand alone — "wait outside
// for me" is valid on its own, or "wait outside the door for me"). Each
// following word is checked with a negative lookahead rejecting
// coordinating conjunctions ("and", "then", "or", "but", "to") — so a
// compound instruction like "wait AT THE STORE AND BUY MILK for me" cannot
// have its trailing real task ("buy milk") swallowed into the location
// clause: the conjunction breaks the qualifier match before it ever reaches
// "for me", so the whole alternative fails to match.
// The "wait until TIME" alternative is anchored to BOTH the start and end
// of the string (only leading/trailing whitespace and a trailing period
// allowed) so it cannot match as a fragment of a longer compound
// instruction in either direction — neither a trailing "wait until 8, THEN
// CLEAN THE KITCHEN" nor a leading "CLEAN THE KITCHEN, then wait until 8".
const OWNER_TARGET_COMMUNICATION =
  /\b(?:call|contact|text|message|whatsapp|ring|phone|reach)\s+(?:me|us)\b|\bgive\s+(?:me|us)\s+a\s+(?:call|ring)\b|\bwait\b(?:\s+(?:in|at|by|near)(?:\s+(?!(?:and|then|or|but|to)\b)[a-z']+){1,3}|\s+(?:outside|inside)(?:\s+(?!(?:and|then|or|but|to)\b)[a-z']+){0,3})?\s+(?:for|here\s+for)\s+(?:me|us)\b|^\s*wait\s+(?:until|till)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\.?\s*$|\blet\s+(?:me|us)\s+know\b/i;

// KNOWN, DOCUMENTED LIMITATION — flagged by review, not yet fixed. This is a
// "contains" match, not "the whole text is only communication": a compound
// instruction pairing real trackable work with a communication clause is
// misclassified as fully communication-style, so sendDelegation() reroutes
// the ENTIRE instruction to a plain message and the trackable work item is
// never created. This applies in BOTH directions:
//   - trailing communication clause after real work: "clean the kitchen
//     and let me know when done"
//   - trailing real work after a location-qualified "wait ... for me"
//     communication clause: "wait in the kitchen for me and then clean the
//     garage" (raised by CodeRabbit on PR #50, alongside the now-fixed
//     leading/trailing "wait until TIME" anchoring)
// A full `^...$` anchor isn't viable for the "wait ... for me" alternative
// either — the confirmed regression case "wait for me in the kitchen. I'm
// on my way." must still classify as communication despite trailing
// content. A safe fix needs to distinguish "communication phrase with
// descriptive trailing content" from "actionable clause + conjunction +
// communication phrase" (e.g. detect a coordinating conjunction joining an
// action-verb clause on either side of the communication phrase) —
// genuinely new logic, not a small extension of this regex, and not proven
// by any confirmed production incident. See the it.todo entries in
// carson-protected-behaviors.test.ts and RA7ETBAL_STATE.md.
export function isCommunicationStyleTaskText(taskText: string): boolean {
  return OWNER_TARGET_COMMUNICATION.test(taskText.trim());
}
