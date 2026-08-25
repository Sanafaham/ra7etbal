/**
 * Deterministic, pure eligibility gate for the task-linked pre-action
 * substitution_request path.
 *
 * Root cause this closes: `resolveInboundStaffTask()`'s recent-pending-task
 * delivery fallback (whatsapp-webhook.js) — the mechanism that lets a
 * message resolve to "the one recent pending task assigned to this person"
 * when there is no WhatsApp quoted-reply context — was gated to media
 * messages only (`Boolean(msg.mediaId)`). A plain-text substitution ask
 * ("Can I use mushroom instead?") has no quoted-reply and no media, so it
 * never reached that fallback and staff_messages.task_id landed NULL.
 *
 * Task resolution runs BEFORE classification (the Claude call in
 * _staff-comms-engine.js has not run yet at this point), so eligibility
 * cannot be based on the classifier's own "substitution_request" label —
 * it must be decided from the raw inbound text alone, deterministically.
 *
 * Widening the fallback to all text was rejected: an ordinary unrelated
 * staff message ("What time should I pick up the kids?", "Thanks, will do")
 * would then blindly attach to whatever task happens to be pending, purely
 * because one exists — a false linkage, not a fix. This gate is
 * deliberately narrow: it reuses the exact phrase set the classifier's own
 * SYSTEM_PROMPT HARD RULE (_staff-comms-engine.js) already treats as a
 * permission/approval request ("should i" / "can i" / "is it ok(ay) if" /
 * "do you approve" / "may i"), and requires it alongside an explicit
 * substitution/deviation signal ("instead" / "substitute" / "swap" /
 * "replace" / "in place of"). Both must be present. This is a scope
 * decision, not a coverage guarantee: it will miss unusually-phrased
 * substitution requests (same class of known, disclosed limitation as
 * carson-attention-intent-guard.ts's regex-based detection) and, in a rare
 * case, could still match a coincidental phrase in an unrelated message —
 * a smaller and more defensible residual risk than matching all text.
 *
 * This function only decides fallback ELIGIBILITY. It never itself
 * resolves, links, or fabricates a task — resolveInboundStaffTask()'s
 * existing single-match / ambiguous / not-found guard is unchanged and
 * still the only thing that actually assigns task_id.
 */

const PERMISSION_PHRASE = /\b(can i|should i|is it (?:ok|okay) if|do you approve|may i)\b/i;
const SUBSTITUTION_SIGNAL = /\b(instead|substitute[sd]?|substitution|swap(?:ping)?|replace(?:ment)?|in place of)\b/i;

export function isLikelyPreActionSubstitutionRequest(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return PERMISSION_PHRASE.test(trimmed) && SUBSTITUTION_SIGNAL.test(trimmed);
}
