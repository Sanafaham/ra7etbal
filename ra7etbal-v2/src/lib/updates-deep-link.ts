/**
 * A notification deep link (/updates?tab=…&task=…) names the tab the task
 * was expected to be in when the link was created. Classification can
 * differ from that guess — an escalated, unanswered delegation is Waiting,
 * not Needs You, yet escalation alerts created before this fix still link
 * to Needs You. Opening such a link must land on the task, not on an empty
 * tab. Classification itself is never changed here.
 */
export type TaskDeepLinkTab = "needs-you" | "waiting";

export function resolveTaskDeepLinkTab(
  requestedTab: string,
  taskId: string | null,
  sections: { needsYouIds: ReadonlySet<string>; waitingIds: ReadonlySet<string> },
): TaskDeepLinkTab | null {
  if (!taskId) return null;
  if (requestedTab !== "needs-you" && requestedTab !== "waiting") return null;
  const inNeedsYou = sections.needsYouIds.has(taskId);
  const inWaiting = sections.waitingIds.has(taskId);
  if (requestedTab === "needs-you" && !inNeedsYou && inWaiting) return "waiting";
  if (requestedTab === "waiting" && !inWaiting && inNeedsYou) return "needs-you";
  return null;
}
