import { createDelegationTaskAndMessage, rewriteOwnerPronouns } from "./delegations";
import { buildDelegationMessage } from "./delegation-message";
import { createMessage } from "./messages";
import { resizeImage, uploadTaskImage, uploadTaskAttachment } from "./image-upload";
import { supabase } from "./supabase";
import { createTask } from "./tasks";
import { createTodo } from "./carson-todos";
import { saveCarsonNote } from "./carson-notes";
import { createReminderTask } from "./reminders";
import type { ExtractedItem } from "../types/extraction";
import type { Message } from "../types/message";
import type { Person } from "../types/person";
import type { Task } from "../types/task";
import type { CarsonTodo } from "./carson-todos";

/**
 * Save the reviewed extraction to Supabase.
 *
 * Rules:
 *  - `message` items become a row in `messages` (no task).
 *  - `parked` items (passive ideas/information) become a row in `carson_notes`,
 *    not `tasks` — they are not yet actionable by definition.
 *  - `todo` items (deterministically reclassified from action/errand by
 *    applyTodoRouting — see todo-routing.ts) become a row in `carson_todos`.
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
  /** "todo"-typed items routed into carson_todos instead of `tasks` — see todo-routing.ts. */
  todos: CarsonTodo[];
  /** How many "parked"-typed items were saved into carson_notes (passive ideas/info). */
  notesSaved: number;
  /** How many items were intentionally skipped (e.g. message without recipient). */
  skipped: number;
  /**
   * Maps task.id → image_path for every task that had an image uploaded in
   * this save. Populated at upload time (before DB round-trips) so callers
   * such as Review.tsx can pass imagePath to sendWhatsAppTask without having
   * to trust that DB responses propagate image_path correctly.
   */
  imagePathsByTaskId: Map<string, string | null>;
}

export interface SaveTimingObserver {
  addSupabaseDuration(durationMs: number): void;
}

async function measureSupabaseOperation<T>(
  observer: SaveTimingObserver | undefined,
  operation: () => PromiseLike<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    observer?.addSupabaseDuration(performance.now() - startedAt);
  }
}

export async function savePending(
  items: ExtractedItem[],
  userId: string,
  ownerName?: string | null,
  people: Person[] = [],
  imageFiles?: Map<string, File>,
  timingObserver?: SaveTimingObserver,
): Promise<SaveResult> {
  if (!userId) throw new Error("Not signed in.");

  const tasks: Task[] = [];
  const messages: Message[] = [];
  const todos: CarsonTodo[] = [];
  let notesSaved = 0;
  let skipped = 0;
  const imagePathsByTaskId = new Map<string, string | null>();

  for (const item of items) {
    // "parked" = passive idea/information the user wants remembered, not
    // acted on ("Save this idea...", "Remember this thought...", "Hold this
    // thought...", "Add this to my notes..."). Previously these were
    // silently skipped and never persisted anywhere. Now they're saved into
    // carson_notes, same table/shape as save_note (Voice Carson) and the
    // manual Notes tab — see carson-notes.ts.
    if (item.type === "parked") {
      const trimmed = item.description.trim();
      if (trimmed) {
        await measureSupabaseOperation(timingObserver, () =>
          saveCarsonNote(trimmed, "general", "clear_my_head"),
        );
        notesSaved += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    // "todo" items never go through the tasks pipeline — they're active
    // personal commitments with no due date and no delegate, routed here
    // deterministically by applyTodoRouting() in extract.ts. Fixes the bug
    // where "Add buy flowers to my to-do list" created a `tasks` row
    // (surfaced under Needs You) instead of a carson_todos row.
    if (item.type === "todo") {
      const todo = await measureSupabaseOperation(timingObserver, () =>
        createTodo(item.description.trim(), null, "clear_my_head"),
      );
      todos.push(todo);
      continue;
    }

    if (item.type === "message") {
      const recipient =
        item.assignedTo && item.assignedTo !== "__me__" ? item.assignedTo : null;
      if (!recipient) {
        skipped += 1;
        continue;
      }
      // For known people (in the People list), always rebuild from
      // buildDelegationMessage so the final stored content is deterministic
      // and never relies on AI-generated text. For unknown recipients
      // (needsPerson: true / person not found), fall back to AI text.
      const assignedPersonMsg = people.find(
        (person) => person.name.trim().toLowerCase() === recipient.toLowerCase(),
      );
      const content = assignedPersonMsg
        ? rewriteOwnerPronouns(
            buildDelegationMessage({
              personName: recipient,
              taskText: item.description,
              personNotes: assignedPersonMsg.notes ?? null,
              ownerName,
            }),
            ownerName,
          )
        : (item.suggestedMessage ?? item.description).trim();
      if (!content) {
        skipped += 1;
        continue;
      }
      const row = await measureSupabaseOperation(timingObserver, () =>
        createMessage({
          user_id: userId,
          task_id: null,
          recipient,
          content,
          confirmation_url: null,
        }),
      );
      messages.push(row);
      continue;
    }

    // Tasks branch
    const assignedTo =
      item.assignedTo && item.assignedTo !== "__me__" ? item.assignedTo : null;
    const isDelegation = item.type === "delegation" && !!assignedTo;
    const needsFollowUp = isDelegation || item.type === "followup";

    // If the user attached an image to this item, upload it now.
    // Upload must succeed before createTask — we never store a path that
    // points to a failed upload.
    let imagePath: string | null = null;
    const imageFile = imageFiles?.get(item.id) ?? null;
    if (imageFile) {
      // Pre-generate the taskId so the upload path matches the task row.
      const pregenId = crypto.randomUUID();
      const blob = await resizeImage(imageFile);
      imagePath = await measureSupabaseOperation(timingObserver, () =>
        uploadTaskImage(userId, pregenId, blob),
      );
      // Record at upload time — before any DB round-trip — so callers can
      // reliably retrieve imagePath without depending on SELECT responses.
      imagePathsByTaskId.set(pregenId, imagePath);
      // createTask will use this pre-generated id so paths stay in sync.
      if (isDelegation && assignedTo) {
        const assignedPerson = people.find(
          (person) => person.name.trim().toLowerCase() === assignedTo.toLowerCase(),
        );
        const result = await measureSupabaseOperation(timingObserver, () =>
          createDelegationTaskAndMessage({
            source: "save",
            userId,
            assignee: {
              name: assignedTo,
              notes: assignedPerson?.notes ?? null,
            },
            taskText: item.description,
            note: item.personalNote,
            imagePath,
            dueAt: item.dueAt,
            ownerName,
            taskId: pregenId,
            onEscalationError: (err, task) =>
              console.error("[save] QStash scheduleEscalationMessages failed for task", task.id, err),
          }),
        );
        tasks.push(result.task);
        if (result.message) messages.push(result.message);
        continue;
      }

      let task = await measureSupabaseOperation(timingObserver, () =>
        item.type === "reminder"
          ? createReminderTask({
              id: pregenId,
              userId,
              text: item.description,
              dueAt: item.dueAt,
              source: "save",
              imagePath,
            })
          : createTask({
              id: pregenId,
              user_id: userId,
              description: item.description.trim(),
              type: item.type as Task["type"],
              assigned_to: assignedTo,
              status: "pending",
              needs_follow_up: needsFollowUp,
              confirmation_url: null,
              due_at: item.dueAt,
              image_path: imagePath,
            }),
      );

      // Defensive status check
      if (task.status !== "pending") {
        console.warn(
          "savePending: task came back with unexpected status; correcting to pending",
          { id: task.id, returned: task.status },
        );
        const { data, error } = await measureSupabaseOperation(
          timingObserver,
          () =>
            supabase
              .from("tasks")
              .update({ status: "pending", confirmed_at: null })
              .eq("id", task.id)
              .select(
                "id, user_id, description, type, assigned_to, status, needs_follow_up, confirmation_url, confirmed_at, due_at, archived_at, created_at, qstash_message_id, followup_sent_at, escalated_at, image_path, proof_image_path, quality_review_status, quality_review_note, quality_reviewed_at",
              )
              .single(),
        );
        if (error) throw error;
        task = data as Task;
      }

      tasks.push(task);
      continue;
    }

    if (isDelegation && assignedTo) {
      const assignedPerson = people.find(
        (person) => person.name.trim().toLowerCase() === assignedTo.toLowerCase(),
      );
      const result = await measureSupabaseOperation(timingObserver, () =>
        createDelegationTaskAndMessage({
          source: "save",
          userId,
          assignee: {
            name: assignedTo,
            notes: assignedPerson?.notes ?? null,
          },
          taskText: item.description,
          note: item.personalNote,
          dueAt: item.dueAt,
          ownerName,
          onEscalationError: (err, task) =>
            console.error("[save] QStash scheduleEscalationMessages failed for task", task.id, err),
        }),
      );
      tasks.push(result.task);
      if (result.message) messages.push(result.message);
      continue;
    }

    // No image — original path
    let task = await measureSupabaseOperation(timingObserver, () =>
      item.type === "reminder"
        ? createReminderTask({
            userId,
            text: item.description,
            dueAt: item.dueAt,
            source: "save",
          })
        : createTask({
            user_id: userId,
            description: item.description.trim(),
            type: item.type as Task["type"],
            assigned_to: assignedTo,
            status: "pending",
            needs_follow_up: needsFollowUp,
            confirmation_url: null,
            due_at: item.dueAt,
          }),
    );

    // Defensive: if any column-level default or trigger flipped the row to
    // done, immediately correct it. New saves must always start as pending —
    // only the recipient (via /api/confirm-task) or the host (via the
    // explicit "Mark done" button) is allowed to mark a task done.
    if (task.status !== "pending") {
      console.warn(
        "savePending: task came back with unexpected status; correcting to pending",
        { id: task.id, returned: task.status },
      );
      const { data, error } = await measureSupabaseOperation(
        timingObserver,
        () =>
          supabase
            .from("tasks")
            .update({ status: "pending", confirmed_at: null })
            .eq("id", task.id)
            .select(
              "id, user_id, description, type, assigned_to, status, needs_follow_up, confirmation_url, confirmed_at, due_at, archived_at, created_at, qstash_message_id, followup_sent_at, escalated_at, image_path, proof_image_path, quality_review_status, quality_review_note, quality_reviewed_at",
            )
            .single(),
      );
      if (error) throw error;
      task = data as Task;
    }

    tasks.push(task);
  }

  return { tasks, messages, todos, notesSaved, skipped, imagePathsByTaskId };
}

/**
 * Upload all provided files as task_attachments and update attachment_count.
 * All files (including the first) are uploaded so the confirmation page
 * can render a complete grid.
 *
 * Returns the total attachment count on success. Throws on any upload failure
 * so the caller can decide whether to surface the error.
 */
export async function saveTaskAttachments(
  taskId: string,
  userId: string,
  files: File[],
  timingObserver?: SaveTimingObserver,
): Promise<number> {
  if (files.length === 0) return 0;

  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const blob = await resizeImage(files[i]);
    const path = await measureSupabaseOperation(timingObserver, () =>
      uploadTaskAttachment(userId, taskId, i, blob),
    );
    paths.push(path);
  }

  const rows = paths.map((storagePath, i) => ({
    task_id: taskId,
    user_id: userId,
    storage_path: storagePath,
    content_type: "image/jpeg",
    sort_order: i,
  }));

  const { error: insertError } = await measureSupabaseOperation(
    timingObserver,
    () => supabase.from("task_attachments").insert(rows),
  );
  if (insertError) throw insertError;

  const { error: updateError } = await measureSupabaseOperation(
    timingObserver,
    () =>
      supabase
        .from("tasks")
        .update({ attachment_count: files.length })
        .eq("id", taskId),
  );
  if (updateError) throw updateError;

  return files.length;
}
