import { buildDelegationMessage } from "./delegation-message";
import { createMessage } from "./messages";
import { injectPersonalNote, normalizePersonalNote, stripClosingLine } from "./personal-note";
import { composeMergedMessage } from "./ai/compose-message";
import { scheduleEscalationMessages } from "./qstash-escalation";
import { createTask } from "./tasks";
import { renderOwnerPerspective, resolveOwnerPerspective, type DeclaredOwnerPerspective } from "./direct-message-owner-normalization";
import type { Message } from "../types/message";
import type { Person } from "../types/person";
import type { Task } from "../types/task";

export const CANONICAL_CONFIRMATION_ORIGIN = "https://www.ra7etbal.com";

export interface DelegationAssignee {
  name: string;
  phone?: string | null;
  notes?: string | null;
  whatsapp_opted_in?: boolean | null;
  /**
   * The assignee's real people.id, when the caller already resolved one
   * (e.g. an exact id or exact-name match against the people table).
   * Never invented from the name alone — left undefined/null when the
   * caller only has free text. Passing a Person object here already
   * satisfies this via structural typing (Person.id flows through).
   */
  id?: string | null;
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
  /**
   * Set only when taskText/note came from the extraction model call, with the
   * perspective status that call declared. Absent = the owner's own words on a
   * deterministic path. See resolveDelegationTaskText.
   */
  ownerPerspective?: DeclaredOwnerPerspective;
}

export interface CreateDelegationTaskAndMessageResult {
  task: Task;
  message: Message | null;
  messageText: string;
  confirmationUrl: string;
}

/**
 * The task text as the assignee should read it, through the single
 * owner-perspective contract (shared/owner-perspective.js). The owner's own
 * words (no declared status) use task-text voice: the owner's "I/me/my"
 * become the owner, with correct grammar; "you" is the assignee and stays;
 * third parties stay third parties. Text the extraction model already
 * composed (declared status present) is verified in "composed" voice and
 * never rewritten; anything but "rendered" fails closed. Throws
 * OwnerPerspectiveError — nothing is created or sent — when the perspective
 * cannot be resolved safely.
 */
export function resolveDelegationTaskText(
  taskText: string,
  assigneeName: string,
  ownerName?: string | null,
  declared?: DeclaredOwnerPerspective,
): string {
  const owner = ownerName?.trim() || "the sender";
  return renderOwnerPerspective(taskText, declared === undefined
    ? { ownerName: owner, recipientName: assigneeName, voice: "task_text" }
    : { ownerName: owner, recipientName: assigneeName, voice: "composed", declared });
}

export async function buildDelegationMessageContent({
  personName,
  taskText,
  personalNote,
  personNotes,
  ownerName,
  ownerPerspective,
}: {
  personName: string;
  taskText: string;
  personalNote?: string | null;
  personNotes?: string | null;
  ownerName?: string | null;
  ownerPerspective?: DeclaredOwnerPerspective;
}): Promise<string> {
  const resolvedTask = resolveDelegationTaskText(taskText, personName, ownerName, ownerPerspective);
  const normalizedNote = normalizePersonalNote(personalNote ?? "", ownerName, personName, ownerPerspective);

  if (normalizedNote) {
    const merged = await composeMergedMessage({
      personName,
      taskText: resolvedTask,
      personalNote: normalizedNote,
      ownerName,
    });
    if (merged) {
      // The merge model call declares no perspective status, so its output is
      // only accepted when the boundary finds nothing to resolve in it: both
      // inputs were already verified, and any owner first person, recipient
      // named as a third party, or unverifiable Arabic/Turkish in the merged
      // text means the merge lost track of who is who. Otherwise the
      // deterministic message below is built from the verified parts.
      const checked = resolveOwnerPerspective(merged, { ownerName, recipientName: personName, voice: "owner_to_recipient" });
      if (checked.status === "unchanged") return checked.text;
    }
  }

  return injectPersonalNote(
    stripClosingLine(buildDelegationMessage({ personName, taskText: resolvedTask, personNotes, ownerName })),
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
  scheduleEscalation = true,
  createCompanionMessage = true,
  onEscalationError,
  ownerPerspective,
}: CreateDelegationTaskAndMessageInput): Promise<CreateDelegationTaskAndMessageResult> {
  if (!userId) throw new Error("Not signed in.");

  const assigneeName = assignee.name.trim();
  if (!assigneeName) throw new Error("Delegation assignee is required.");
  if (!taskText.trim()) throw new Error("Delegation task text is required.");
  // Stored as the assignee reads it, so the confirm page, the message and
  // every later follow-up quote the same correctly-referenced task.
  const description = resolveDelegationTaskText(taskText.trim(), assigneeName, ownerName, ownerPerspective);

  const id = taskId?.trim() || crypto.randomUUID();
  const confirmationUrl = `${CANONICAL_CONFIRMATION_ORIGIN}/confirm?task=${encodeURIComponent(id)}`;
  const messageText = await buildDelegationMessageContent({
    personName: assigneeName,
    taskText: description,
    personalNote: note,
    personNotes: assignee.notes ?? null,
    ownerName,
    ownerPerspective,
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
        person_id: assignee.id ?? null,
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
