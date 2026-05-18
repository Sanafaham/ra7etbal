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
  created_at: string;
}

export interface TaskDraft {
  description: string;
  type: TaskType;
  assigned_to: string | null;
  status: TaskStatus;
  needs_follow_up: boolean;
  confirmation_url: string | null;
}

export type TaskPatch = Partial<Pick<Task, "description" | "status" | "assigned_to" | "confirmed_at" | "needs_follow_up">>;
