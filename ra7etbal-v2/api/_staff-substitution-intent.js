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
 * permission/approval request ("should i" / "can i" / "is it ok(ay)" /
 * "do you approve" / "may i"), and requires it alongside an explicit
 * substitution/scarcity signal. Both must be present. This is a scope
 * decision, not a coverage guarantee: it will miss unusually-phrased
 * substitution requests (same class of known, disclosed limitation as
 * carson-attention-intent-guard.ts's regex-based detection) and, in a rare
 * case, could still match a coincidental phrase in an unrelated message —
 * a smaller and more defensible residual risk than matching all text.
 *
 * 2026-08-26 widening (real production test, Christopher/TEREA Silver ->
 * Turquoise): the real caption "I found only Turquoise. Is it ok?" matched
 * neither the original permission-phrase set (required a trailing "if"
 * after "is it ok/okay") nor the original substitution-signal set (no
 * instead/substitute/swap/replace/"in place of" word present) — a genuine
 * pre-action proposal was gated out. The permission-phrase set now also
 * matches bare "is it ok"/"is it okay" without requiring "if"; the
 * substitution-signal set now also matches scarcity/unavailability
 * phrasing ("only", "out of", "don't have", "ran out", "no more",
 * "couldn't find"/"could not find", "unavailable") — the natural way
 * someone describes "I couldn't get the exact thing" without ever saying
 * "instead". Purely additive: every phrase the narrower patterns matched
 * before still matches; nothing that was previously rejected and is
 * genuinely ordinary conversation (verified by the full existing negative
 * test matrix, re-run unchanged) now matches.
 *
 * This function only decides fallback ELIGIBILITY (and, since 2026-08-26,
 * media-vs-text-escalation routing eligibility in whatsapp-webhook.js). It
 * never itself resolves, links, or fabricates a task — resolveInboundStaffTask()'s
 * existing single-match / ambiguous / not-found guard is unchanged and
 * still the only thing that actually assigns task_id.
 */

const PERMISSION_PHRASE = /\b(can i|should i|is it (?:ok|okay)\b|do you approve|may i)\b/i;
const SUBSTITUTION_SIGNAL = /\b(instead|substitute[sd]?|substitution|swap(?:ping)?|replace(?:ment)?|in place of|only|out of|don't have|ran out|no more|couldn't find|could not find|unavailable)\b/i;

export function isLikelyPreActionSubstitutionRequest(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return PERMISSION_PHRASE.test(trimmed) && SUBSTITUTION_SIGNAL.test(trimmed);
}
