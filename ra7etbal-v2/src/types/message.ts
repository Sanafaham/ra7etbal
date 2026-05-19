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
}
