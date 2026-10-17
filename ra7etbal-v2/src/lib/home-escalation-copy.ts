/**
 * Home copy for escalated, unanswered delegations.
 *
 * An escalated delegation stays in Waiting — Needs You is the owner-decision
 * queue and its classification is unchanged. Home must still not claim an
 * all-clear while someone has not confirmed a task Carson escalated, but it
 * must not imply the owner has to step in either: Carson is still following up.
 */
import type { Task } from "../types/task";

export function countEscalatedWaiting(waiting: Pick<Task, "escalated_at">[]): number {
  return waiting.reduce((count, task) => count + (task.escalated_at ? 1 : 0), 0);
}

export const ESCALATED_WAITING_HEADLINE = "Carson is following up.";

export function buildEscalatedWaitingSentence(waitingCount: number, escalatedCount: number): string {
  if (escalatedCount >= waitingCount) {
    return escalatedCount === 1
      ? "One item hasn't been confirmed yet."
      : `${escalatedCount} items haven't been confirmed yet.`;
  }
  return `${waitingCount} items are waiting on others; ${escalatedCount} not confirmed yet.`;
}
