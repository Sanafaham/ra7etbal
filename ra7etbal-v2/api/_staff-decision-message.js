/**
 * Workstream 3 — the one canonical staff-facing message builder for every
 * task-based owner decision (substitute review, proof-photo review).
 *
 * Deliberately narrow input surface: `decision` is a closed enum already
 * validated upstream (ESCALATION_DECISIONS / VALID_SUBSTITUTE_DECISIONS in
 * task-confirm.js), `instructionText` is only ever the owner's own submitted
 * words (never a task/QI field), and `confirmationUrl` is built internally
 * by buildFreshWorkerConfirmationUrl — never attacker- or model-controlled.
 * There is no parameter here that can carry Quality Intelligence reasoning,
 * a review note, or any other synthesized/internal text. That is what makes
 * this structurally leak-proof rather than merely filtered: staff can only
 * ever receive one of a small fixed set of sentences, or the owner's own
 * words verbatim under the "From the owner:" prefix.
 */

// Single-spaced, not newline-separated: both send pipelines strip
// newlines/tabs from the outbound template parameter before it reaches Meta
// (Meta rejects template params containing \n/\t), but they collapse
// whitespace with different regexes (task-confirm.js's handleOwnerDecision
// vs. resolveAndDeliverEscalationAnswer). A newline-joined constant would
// flatten to different byte output on each pipeline; a single-spaced one
// flattens identically on both, which is what "one canonical builder, no
// UI-dependent differences" actually requires once the shared post-send
// normalization is accounted for.
const APPROVED_MESSAGE = 'Approved. You can go ahead.';
const REJECTED_MESSAGE =
  'Please wait. The owner did not approve this. You will receive further instructions shortly.';

const APPROVED_DECISIONS = new Set(['approved', 'approved_alternative']);
const REJECTED_DECISIONS = new Set(['rejected', 'rejected_alternative']);

export function buildCanonicalStaffDecisionMessage({ decision, instructionText, confirmationUrl } = {}) {
  const base = APPROVED_DECISIONS.has(decision)
    ? APPROVED_MESSAGE
    : REJECTED_DECISIONS.has(decision)
    ? REJECTED_MESSAGE
    : `From the owner: ${String(instructionText || '').trim() || 'please see instructions.'}`;
  return confirmationUrl ? `${base}\n\n${confirmationUrl}` : base;
}
