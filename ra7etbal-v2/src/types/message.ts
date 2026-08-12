export interface Message {
  id: string;
  user_id: string;
  /** When the message accompanies a delegation task, links to it. */
  task_id: string | null;
  recipient: string;
  content: string;
  /** Confirmation link to share (for delegation messages); null otherwise. */
  confirmation_url: string | null;
  /**
   * Durable link to people.id, independent of task_id. Populated only when
   * the caller already resolved a real Person before creating this message
   * (an exact id or exact-name match against the people table) — never
   * guessed from free text. Survives the linked task being deleted later
   * (Clear History, voice "delete that task"), unlike task_id.
   */
  person_id: string | null;
  /**
   * Non-null when the message has been moved out of the active workspace
   * (typically as part of archiving its linked task). Archived rows are
   * filtered out of /messages but remain visible in /history.
   */
  archived_at: string | null;
  created_at: string;
}

export interface MessageDraft {
  /** Required — we set this explicitly instead of relying on a column default. */
  user_id: string;
  task_id: string | null;
  recipient: string;
  content: string;
  confirmation_url: string | null;
  /** Optional — only set when the caller already has a resolved Person.id. */
  person_id?: string | null;
}
