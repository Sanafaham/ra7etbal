import type { Task } from "../types/task";

/**
 * Selects owner-facing confirmation banners that are still visible.
 * Dismissal state lives on the task row so it survives refresh, sign-out,
 * sign-in, installed-app storage boundaries, and use on another device.
 */

const MAX_NOTICES = 5;

export function selectConfirmationNotices(tasks: Task[]): Task[] {
  return tasks
    .filter(
      (task) =>
        task.type === "delegation" &&
        task.status === "done" &&
        !!task.confirmed_at &&
        !task.dismissed_at,
    )
    .sort(
      (a, b) => new Date(b.confirmed_at!).getTime() - new Date(a.confirmed_at!).getTime(),
    )
    .slice(0, MAX_NOTICES);
}
