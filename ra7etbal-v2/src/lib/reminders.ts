import type { Task } from "../types/task";
import {
  createRoutedReminder,
  REMINDER_CREATION_CONTRACT_VERSION,
  type ReminderCreationSource,
} from "./qstash-reminder";
import type { OneTimeRoutingEvidence } from "./one-time-automation-routing";

interface CreateReminderTaskInput {
  userId: string;
  text: string;
  dueAt: string | null;
  source: ReminderCreationSource;
  id?: string;
  imagePath?: string | null;
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
  routingEvidence,
}: CreateReminderTaskInput): Promise<Task> {
  const description = text.trim();
  if (!userId) throw new Error("Not signed in.");
  if (!description) throw new Error("Cannot create a reminder without text.");

  const operationId = id ?? routingEvidence?.operation_id ?? crypto.randomUUID();
  return createRoutedReminder({
    description,
    dueAt,
    imagePath,
    routingEvidence,
    creationContract: routingEvidence
      ? undefined
      : {
          contract_version: REMINDER_CREATION_CONTRACT_VERSION,
          source,
          operation_id: operationId,
        },
  });
}
