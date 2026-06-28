import { buildDelegationMessage } from "./delegation-message";
import { createMessage } from "./messages";
import { injectPersonalNote, normalizePersonalNote, stripClosingLine } from "./personal-note";
import { composeMergedMessage } from "./ai/compose-message";
import { scheduleEscalationMessages } from "./qstash-escalation";
import { createTask } from "./tasks";
import type { Message } from "../types/message";
import type { Person } from "../types/person";
import type { Task } from "../types/task";

export interface DelegationAssignee {
  name: string;
  phone?: string | null;
  notes?: string | null;
  whatsapp_opted_in?: boolean | null;
}

export interface CreateDelegationTaskAndMessageInput {
  source: string;
  userId: string;
  assignee: DelegationAssignee;
  taskText: string;
  note?: string | null;
  imagePath?: string | null;
  dueAt?: string | null;
  ownerName?: string | null;
  taskId?: string | null;
  confirmationOrigin?: string | null;
  scheduleEscalation?: boolean;
  createCompanionMessage?: boolean;
  onEscalationError?: (err: unknown, task: Task) => void;
}

export interface CreateDelegationTaskAndMessageResult {
  task: Task;
  message: Message | null;
  messageText: string;
  confirmationUrl: string;
}

export function rewriteOwnerPronouns(text: string, ownerName?: string | null): string {
  const name = ownerName?.trim() || "the sender";
  return text
    .replace(/\bmy\b/gi, `${name}'s`)
    .replace(/\bmyself\b/gi, name)
    .replace(/\bme\b/gi, name)
    .replace(/\bI\b/g, name);
}

export async function buildDelegationMessageContent({
  personName,
  taskText,
  personalNote,
  personNotes,
  ownerName,
}: {
  personName: string;
  taskText: string;
  personalNote?: string | null;
  personNotes?: string | null;
  ownerName?: string | null;
}): Promise<string> {
  const normalizedNote = normalizePersonalNote(personalNote ?? "", ownerName);

  if (normalizedNote) {
    const merged = await composeMergedMessage({
      personName,
      taskText,
      personalNote: normalizedNote,
      ownerName,
    });
    if (merged) return merged;
  }

  return injectPersonalNote(
    stripClosingLine(
      rewriteOwnerPronouns(
        buildDelegationMessage({ personName, taskText, personNotes, ownerName }),
        ownerName,
      ),
    ),
    normalizedNote,
  );
}

export async function createDelegationTaskAndMessage({
  source,
  userId,
  assignee,
  taskText,
  note = null,
  imagePath = null,
  dueAt = null,
  ownerName = null,
  taskId = null,
  confirmationOrigin = null,
  scheduleEscalation = true,
  createCompanionMessage = true,
  onEscalationError,
}: CreateDelegationTaskAndMessageInput): Promise<CreateDelegationTaskAndMessageResult> {
  if (!userId) throw new Error("Not signed in.");

  const assigneeName = assignee.name.trim();
  const description = taskText.trim();
  if (!assigneeName) throw new Error("Delegation assignee is required.");
  if (!description) throw new Error("Delegation task text is required.");

  const id = taskId?.trim() || crypto.randomUUID();
  const origin = confirmationOrigin ?? window.location.origin;
  const confirmationUrl = `${origin}/confirm?task=${encodeURIComponent(id)}`;
  const messageText = await buildDelegationMessageContent({
    personName: assigneeName,
    taskText: description,
    personalNote: note,
    personNotes: assignee.notes ?? null,
    ownerName,
  });

  const task = await createTask({
    id,
    user_id: userId,
    description,
    type: "delegation",
    assigned_to: assigneeName,
    status: "pending",
    needs_follow_up: true,
    confirmation_url: confirmationUrl,
    due_at: dueAt,
    image_path: imagePath,
  });

  let message: Message | null = null;
  if (createCompanionMessage) {
    try {
      message = await createMessage({
        user_id: userId,
        task_id: task.id,
        recipient: assigneeName,
        content: messageText,
        confirmation_url: confirmationUrl,
      });
    } catch (err) {
      console.warn(`[${source}] companion delegation message creation failed`, err);
    }
  }

  if (scheduleEscalation && task.created_at) {
    scheduleEscalationMessages(task.id, task.created_at).catch((err) => {
      if (onEscalationError) onEscalationError(err, task);
      else console.error(`[${source}] QStash scheduleEscalationMessages failed for task`, task.id, err);
    });
  }

  return { task, message, messageText, confirmationUrl };
}

export function personToDelegationAssignee(person: Person): DelegationAssignee {
  return {
    name: person.name,
    phone: person.phone,
    notes: person.notes ?? null,
    whatsapp_opted_in: person.whatsapp_opted_in ?? null,
  };
}
