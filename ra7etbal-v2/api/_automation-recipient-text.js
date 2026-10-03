import { ownerPerspectiveDetail, renderOwnerPerspective } from '../shared/owner-perspective.js';

/**
 * Recipient-facing text of an automation (or a legacy routine) — the words a
 * staff member will read when it runs — resolved through the single shared
 * owner-perspective boundary (shared/owner-perspective.js). This module only
 * picks the boundary voice; it never rewrites pronouns itself.
 *
 *   - message automations / routines: the owner's own words to the recipient
 *     ("owner_to_recipient");
 *   - delegation automations / routines with an assignee: task text for the
 *     assignee ("task_text": "you" is the assignee);
 *   - an automation with no assignee becomes an owner-only action task: not
 *     recipient-facing, so it is not resolved (null voice).
 *
 * The same function runs at creation/update (api/automations.js — the
 * rendered text is what gets saved) and again at send time
 * (api/process-delegation-escalations.js — rows saved before this boundary
 * existed). Rendering is idempotent, so already-safe text passes unchanged.
 * Throws OwnerPerspectiveError when it cannot be resolved safely.
 */
export function automationRecipientVoice({ automationType, hasRecipient }) {
  if (automationType === 'message') return 'owner_to_recipient';
  return hasRecipient ? 'task_text' : null;
}

export function renderAutomationRecipientText(text, { voice, ownerName, recipientName }) {
  return renderOwnerPerspective(String(text ?? '').trim(), { ownerName, recipientName, voice });
}

/** Owner-facing refusal at creation/update: nothing was created or changed. */
export function automationPerspectiveRefusal(recipientName) {
  const who = String(recipientName || '').trim() || 'them';
  return `I didn't save that automation for ${who}. ${ownerPerspectiveDetail()}`;
}
