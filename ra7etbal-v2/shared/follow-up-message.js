import { resolveOwnerPerspective } from './owner-perspective.js';

/**
 * Staff-facing follow-up text for a stored task record — one builder for the
 * escalation cron (api/process-delegation-escalations.js) and Talk's
 * send_followup tool. task.description is a task record from the owner's
 * side; it is rendered for the assignee through the single owner-perspective
 * contract (shared/owner-perspective.js, "task_record" voice). When that
 * cannot be done safely the follow-up does not quote the task at all rather
 * than guess who "I" or "her" means.
 */
export function buildFollowUpMessageText({ description, ownerName, assignedTo }) {
  const resolved = resolveOwnerPerspective(String(description || ''), { ownerName, recipientName: assignedTo, voice: 'task_record' });
  return resolved.status === 'needs_composition'
    ? `Following up on the task ${ownerName} sent you.`
    : `Following up: ${resolved.text}`;
}
