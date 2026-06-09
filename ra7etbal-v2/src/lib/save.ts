import { createMessage } from "./messages";
import { buildDelegationMessage } from "./delegation-message";
import { resizeImage, uploadTaskImage } from "./image-upload";
import { scheduleReminderPush } from "./qstash-reminder";
import { supabase } from "./supabase";
import { createTask } from "./tasks";
import type { ExtractedItem } from "../types/extraction";
import type { Message } from "../types/message";
import type { Person } from "../types/person";
import type { Task } from "../types/task";

/**
 * Replace first-person owner pronouns in a delegation message so the
 * recipient reads "call Sana" instead of "call me".
 *
 * The message is sent by Ra7etBal on the owner's behalf, so "me" would
 * mean "Ra7etBal" to the recipient — which is wrong.
 *
 * Falls back to "the sender" when no ownerName is provided so the
 * message still reads naturally.
 */
function rewriteOwnerPronouns(text: string, ownerName?: string | null): string {
  const name = ownerName?.trim() || "the sender";
  return text
    .replace(/\bmy\b/gi, `${name}'s`)
    .replace(/\bmyself\b/gi, name)
    .replace(/\bme\b/gi, name)
    .replace(/\bI\b/g, name); // capital I only — avoids altering "i" inside words
}

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
  /**
   * Maps task.id → image_path for every task that had an image uploaded in
   * this save. Populated at upload time (before DB round-trips) so callers
   * such as Review.tsx can pass imagePath to sendWhatsAppTask without having
   * to trust that DB responses propagate image_path correctly.
   */
  imagePathsByTaskId: Map<string, string | null>;
}

export async function savePending(
  items: ExtractedItem[],
  userId: string,
  ownerName?: string | null,
  people: Person[] = [],
  imageFiles?: Map<string, File>,
): Promise<SaveResult> {
  if (!userId) throw new Error("Not signed in.");

  const tasks: Task[] = [];
  const messages: Message[] = [];
  let skipped = 0;
  const imagePathsByTaskId = new Map<string, string | null>();

  for (const item of items) {
    if (item.type === "parked") {
      skipped += 1;
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

    // If the user attached an image to this item, upload it now.
    // Upload must succeed before createTask — we never store a path that
    // points to a failed upload.
    let imagePath: string | null = null;
    const imageFile = imageFiles?.get(item.id) ?? null;
    if (imageFile) {
      // Pre-generate the taskId so the upload path matches the task row.
      const pregenId = crypto.randomUUID();
      const blob = await resizeImage(imageFile);
      imagePath = await uploadTaskImage(userId, pregenId, blob);
      // Record at upload time — before any DB round-trip — so callers can
      // reliably retrieve imagePath without depending on SELECT responses.
      imagePathsByTaskId.set(pregenId, imagePath);
      // createTask will use this pre-generated id so paths stay in sync.
      let task = await createTask({
        id: pregenId,
        user_id: userId,
        description: item.description.trim(),
        type: item.type,
        assigned_to: assignedTo,
        status: "pending",
        needs_follow_up: needsFollowUp,
        confirmation_url: null,
        due_at: item.dueAt,
        image_path: imagePath,
      });

      // Defensive status check
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
            "id, user_id, description, type, assigned_to, status, needs_follow_up, confirmation_url, confirmed_at, due_at, archived_at, created_at, qstash_message_id, followup_sent_at, escalated_at, image_path, proof_image_path",
          )
          .single();
        if (error) throw error;
        task = data as Task;
      }

      if (isDelegation) {
        const confirmationUrl = `${window.location.origin}/confirm?task=${task.id}`;
        task = await updateTaskUrl(task.id, confirmationUrl);
        const assignedPerson = people.find(
          (person) => person.name.trim().toLowerCase() === assignedTo!.toLowerCase(),
        );
        const content = rewriteOwnerPronouns(
          buildDelegationMessage({
            personName: assignedTo!,
            taskText: item.description,
            personNotes: assignedPerson?.notes ?? null,
            ownerName,
          }),
          ownerName,
        );
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

      if (task.type === "reminder" && task.due_at) {
        scheduleReminderPush(task.id, task.due_at).catch((err) =>
          console.error("[save] QStash scheduleReminderPush failed for task", task.id, err),
        );
      }

      tasks.push(task);
      continue;
    }

    // No image — original path
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
          "id, user_id, description, type, assigned_to, status, needs_follow_up, confirmation_url, confirmed_at, due_at, archived_at, created_at, qstash_message_id, followup_sent_at, escalated_at, image_path, proof_image_path",
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
      // Rewrite any owner first-person pronouns ("me" → "Sana", etc.) so the
      // recipient reads the message correctly — this is a code-side safety net
      // in addition to the prompt-level instruction, because LLM output is not
      // guaranteed and displayName may not have been loaded at extraction time.
      const assignedPerson = people.find(
        (person) => person.name.trim().toLowerCase() === assignedTo.toLowerCase(),
      );
      const content = rewriteOwnerPronouns(
        buildDelegationMessage({
          personName: assignedTo,
          taskText: item.description,
          personNotes: assignedPerson?.notes ?? null,
          ownerName,
        }),
        ownerName,
      );
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
      scheduleReminderPush(task.id, task.due_at).catch((err) =>
        console.error("[save] QStash scheduleReminderPush failed for task", task.id, err),
      );
    }

    tasks.push(task);
  }

  return { tasks, messages, skipped, imagePathsByTaskId };
}

async function updateTaskUrl(id: string, url: string): Promise<Task> {
  // Tiny helper that bypasses the typed TaskPatch (which intentionally omits
  // confirmation_url to keep that column write-once at save time).
  // Must select ALL task columns so callers (e.g. save → taskImagePathById)
  // retain image_path and other fields after the update round-trip.
  const { data, error } = await supabase
    .from("tasks")
    .update({ confirmation_url: url })
    .eq("id", id)
    .select(
      "id, user_id, description, type, assigned_to, status, needs_follow_up, confirmation_url, confirmed_at, due_at, archived_at, created_at, qstash_message_id, followup_sent_at, escalated_at, image_path, proof_image_path",
    )
    .single();
  if (error) throw error;
  return data as Task;
}
