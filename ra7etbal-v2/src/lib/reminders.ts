import type { Task } from "../types/task";
import { createRoutedReminder, scheduleReminderPush } from "./qstash-reminder";
import { createTask } from "./tasks";
import type { OneTimeRoutingEvidence } from "./one-time-automation-routing";

interface CreateReminderTaskInput {
  userId: string;
  text: string;
  dueAt: string | null;
  source: string;
  id?: string;
  imagePath?: string | null;
  createTaskFn?: typeof createTask;
  routingEvidence?: OneTimeRoutingEvidence;
}

/**
 * Canonical one-off reminder creation boundary.
 *
 * Creates a pending owner reminder task and schedules the QStash reminder push
 * when due_at is present. This is intentionally not used for recurring
 * reminder routines, which currently create action tasks plus immediate owner
 * push notifications from the server routine runner.
 */
export async function createReminderTask({
  userId,
  text,
  dueAt,
  source,
  id,
  imagePath,
  createTaskFn = createTask,
  routingEvidence,
}: CreateReminderTaskInput): Promise<Task> {
  const description = text.trim();
  if (!userId) throw new Error("Not signed in.");
  if (!description) throw new Error("Cannot create a reminder without text.");

  if (routingEvidence) {
    if (!dueAt) throw new Error("Cannot create a routed reminder without a due time.");
    return createRoutedReminder({ description, dueAt, routingEvidence });
  }

  const task = await createTaskFn({
    ...(id ? { id } : {}),
    user_id: userId,
    description,
    type: "reminder",
    assigned_to: null,
    status: "pending",
    needs_follow_up: false,
    confirmation_url: null,
    due_at: dueAt,
    ...(imagePath !== undefined ? { image_path: imagePath } : {}),
  });

  if (task.due_at) {
    scheduleReminderPush(task.id, task.due_at, routingEvidence).catch((err) =>
      console.error(`[${source}] QStash reminder schedule failed`, task.id, err),
    );
  }

  return task;
}
