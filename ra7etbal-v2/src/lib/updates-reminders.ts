import type { Task } from "../types/task";

const MS_14_DAYS = 14 * 24 * 60 * 60 * 1000;

export function getUpcomingReminderTasks(
  tasks: Task[],
  needsAttention: Task[],
  now = new Date(),
): Task[] {
  const nowMs = now.getTime();
  const needsAttentionIds = new Set(needsAttention.map((task) => task.id));
  const seenIds = new Set<string>();

  return tasks
    .filter((task) => {
      if (seenIds.has(task.id)) return false;
      if (needsAttentionIds.has(task.id)) return false;
      if (task.archived_at != null) return false;
      if (task.status !== "pending") return false;
      if (task.type !== "reminder") return false;
      if (!task.due_at) return false;

      const dueMs = new Date(task.due_at).getTime();
      if (Number.isNaN(dueMs)) return false;
      if (dueMs <= nowMs || dueMs > nowMs + MS_14_DAYS) return false;

      seenIds.add(task.id);
      return true;
    })
    .sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime());
}
