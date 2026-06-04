import { createMessage } from "./messages";
import { scheduleReminderPush } from "./qstash-reminder";
import { supabase } from "./supabase";
import { createTask } from "./tasks";
import type { ExtractedItem } from "../types/extraction";
import type { Message } from "../types/message";
import type { Task } from "../types/task";

/**
 * Save the reviewed extraction to Supabase.
 *
 * Rules:
 *  - `message` items become a row in `messages` (no task).
 *  - `parked` items are skipped — by definition not yet actionable.
 *  - Everything else becomes a row in `tasks`.
 *  - `delegation` rows that have a named non-Me recipient also get a paired
 *    row in `messages` (linked via task_id) carrying the suggestedMessage
 *    and the confirmation URL — that's the host's "copy and send" payload.
 *  - The confirmation URL is built from the saved task's id and persisted
 *    on the task so /confirm and Copy-link work without recomputing.
 *
 * user_id is set EXPLICITLY on every insert. Earlier code relied on the
 * Supabase column default `auth.uid()`, but if that default wasn't applied
 * to the existing v1 columns the insert would still succeed (with user_id
 * = NULL) and the row would then be invisible under the RLS
 * `user_id = auth.uid()` policy. Belt-and-braces: pass it in directly.
 *
 * Returns the created rows so the caller can push them straight into the
 * tasks/messages stores without an extra refetch.
 */

export interface SaveResult {
  tasks: Task[];
  messages: Message[];
  /** How many items were intentionally skipped (e.g. parked, message without recipient). */
  skipped: number;
}

export async function savePending(
  items: ExtractedItem[],
  userId: string,
): Promise<SaveResult> {
  if (!userId) throw new Error("Not signed in.");

  const tasks: Task[] = [];
  const messages: Message[] = [];
  let skipped = 0;

  for (const item of items) {
    if (item.type === "parked") {
      skipped += 1;
      continue;
    }

    if (item.type === "message") {
      const recipient =
        item.assignedTo && item.assignedTo !== "__me__" ? item.assignedTo : null;
      const content = (item.suggestedMessage ?? item.description).trim();
      if (!recipient || !content) {
        skipped += 1;
        continue;
      }
      const row = await createMessage({
        user_id: userId,
        task_id: null,
        recipient,
        content,
        confirmation_url: null,
      });
      messages.push(row);
      continue;
    }

    // Tasks branch
    const assignedTo =
      item.assignedTo && item.assignedTo !== "__me__" ? item.assignedTo : null;
    const isDelegation = item.type === "delegation" && !!assignedTo;
    const needsFollowUp = isDelegation || item.type === "followup";

    let task = await createTask({
      user_id: userId,
      description: item.description.trim(),
      type: item.type,
      assigned_to: assignedTo,
      status: "pending",
      needs_follow_up: needsFollowUp,
      confirmation_url: null,
      due_at: item.dueAt,
    });

    // Defensive: if any column-level default or trigger flipped the row to
    // done, immediately correct it. New saves must always start as pending —
    // only the recipient (via /api/confirm-task) or the host (via the
    // explicit "Mark done" button) is allowed to mark a task done.
    if (task.status !== "pending") {
      console.warn(
        "savePending: task came back with unexpected status; correcting to pending",
        { id: task.id, returned: task.status },
      );
      const { data, error } = await supabase
        .from("tasks")
        .update({ status: "pending", confirmed_at: null })
        .eq("id", task.id)
        .select(
          "id, user_id, description, type, assigned_to, status, needs_follow_up, confirmation_url, confirmed_at, due_at, archived_at, created_at",
        )
        .single();
      if (error) throw error;
      task = data as Task;
    }

    if (isDelegation) {
      const confirmationUrl = `${window.location.origin}/confirm?task=${task.id}`;
      // Persist the URL on the task now that we know its id. confirmation_url
      // is intentionally not in TaskPatch — it's write-once at save time.
      task = await updateTaskUrl(task.id, confirmationUrl);

      // Pair message row for the host to copy and send.
      const content = (item.suggestedMessage ?? "").trim();
      if (content && assignedTo) {
        const msg = await createMessage({
          user_id: userId,
          task_id: task.id,
          recipient: assignedTo,
          content,
          confirmation_url: confirmationUrl,
        });
        messages.push(msg);
      }
    }

    // Schedule an exact-time QStash push job for reminder tasks with a due date.
    if (task.type === "reminder" && task.due_at) {
      void scheduleReminderPush(task.id, task.due_at);
    }

    tasks.push(task);
  }

  return { tasks, messages, skipped };
}

async function updateTaskUrl(id: string, url: string): Promise<Task> {
  // Tiny helper that bypasses the typed TaskPatch (which intentionally omits
  // confirmation_url to keep that column write-once at save time).
  const { data, error } = await supabase
    .from("tasks")
    .update({ confirmation_url: url })
    .eq("id", id)
    .select(
      "id, user_id, description, type, assigned_to, status, needs_follow_up, confirmation_url, confirmed_at, due_at, archived_at, created_at",
    )
    .single();
  if (error) throw error;
  return data as Task;
}
