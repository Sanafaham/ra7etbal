import type { ItemType } from "./extraction";

/** Tasks store everything except free-form messages. */
export type TaskType = Exclude<ItemType, "message">;

export type TaskStatus = "pending" | "done" | "cancelled";

export interface Task {
  id: string;
  user_id: string;
  description: string;
  type: TaskType;
  /** null = the user themselves ("Me"); otherwise the person's name. */
  assigned_to: string | null;
  status: TaskStatus;
  /** True for delegations + follow-ups that need confirmation. */
  needs_follow_up: boolean;
  /** null for non-delegations. */
  confirmation_url: string | null;
  /** Timestamp when status flipped to done. */
  confirmed_at: string | null;
  /** Optional reminder/action due timestamp. */
  due_at: string | null;
  /**
   * Non-null when the task has been moved out of the active workspace via
   * "Archive history". Archived rows are filtered out of Actions / Follow-ups
   * but remain visible in /history.
   */
  archived_at: string | null;
  created_at: string;
  /** QStash message ID stored when a reminder push is scheduled. Null when not scheduled or after delivery. */
  qstash_message_id: string | null;
  /** Timestamp when the automatic 30-min WhatsApp follow-up was sent. Null = not yet sent. */
  followup_sent_at: string | null;
  /** Timestamp when the automatic 60-min owner escalation push was sent. Null = not yet sent. */
  escalated_at: string | null;
}

export interface TaskDraft {
  /**
   * Optional client-supplied UUID. When provided, the row is inserted with
   * this ID so the confirmation_url can be derived before the INSERT fires.
   * When omitted, Supabase generates a UUID via the column default.
   */
  id?: string;
  /** Required — we set this explicitly instead of relying on a column default. */
  user_id: string;
  description: string;
  type: TaskType;
  assigned_to: string | null;
  status: TaskStatus;
  needs_follow_up: boolean;
  confirmation_url: string | null;
  due_at: string | null;
}

export type TaskPatch = Partial<Pick<Task, "description" | "status" | "assigned_to" | "confirmed_at" | "needs_follow_up" | "due_at">>;
