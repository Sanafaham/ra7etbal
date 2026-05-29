import type { Task } from "../types/task";

export type ReminderState = "upcoming" | "due_today" | "overdue" | "completed";

export type AttentionItem =
  | {
      id: string;
      kind: "reminder";
      title: string;
      label: string;
      state: Exclude<ReminderState, "upcoming" | "completed">;
    }
  | {
      id: string;
      kind: "delegation";
      title: string;
      label: string;
      state: "waiting_confirmation";
    };

export function getReminderState(task: Task, now = new Date()): ReminderState | null {
  if (task.type !== "reminder") return null;
  if (task.status === "done") return "completed";
  if (!task.due_at) return "upcoming";

  const due = new Date(task.due_at);
  if (Number.isNaN(due.getTime())) return "upcoming";
  if (due.getTime() < now.getTime()) return "overdue";
  if (isSameLocalDay(due, now)) return "due_today";
  return "upcoming";
}

export function getNeedsAttentionItems(tasks: Task[], now = new Date()): AttentionItem[] {
  return tasks
    .filter((task) => task.status !== "done")
    .flatMap((task): AttentionItem[] => {
      const reminderState = getReminderState(task, now);
      if (reminderState === "overdue" || reminderState === "due_today") {
        return [
          {
            id: task.id,
            kind: "reminder",
            title: task.description,
            label:
              reminderState === "overdue"
                ? formatOverdueLabel(task.due_at, now)
                : formatDueTodayLabel(task.due_at),
            state: reminderState,
          },
        ];
      }

      if (task.type === "delegation" && task.needs_follow_up && task.status !== "done") {
        return [
          {
            id: task.id,
            kind: "delegation",
            title: task.description,
            label: "Waiting for confirmation",
            state: "waiting_confirmation",
          },
        ];
      }

      return [];
    });
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatDueTodayLabel(value: string | null): string {
  if (!value) return "Due today";
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return "Due today";
  return `Due today at ${due.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function formatOverdueLabel(value: string | null, now: Date): string {
  if (!value) return "Overdue";
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return "Overdue";

  const dueStart = startOfLocalDay(due).getTime();
  const nowStart = startOfLocalDay(now).getTime();
  const days = Math.max(0, Math.floor((nowStart - dueStart) / 86_400_000));
  if (days <= 0) return "Overdue today";
  return `Overdue by ${days} ${days === 1 ? "day" : "days"}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
